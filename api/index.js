const PROVIDERS = {
  gemini: {
    defaultModel: "gemini-3.5-flash-lite",
    envKey: "GEMINI_API_KEY",
    envModel: "GEMINI_MODEL"
  },
  openai: {
    defaultModel: "gpt-4o-mini",
    envKey: "OPENAI_API_KEY",
    envModel: "OPENAI_MODEL",
    baseUrl: "https://api.openai.com/v1"
  },
  deepseek: {
    defaultModel: "deepseek-chat",
    envKey: "DEEPSEEK_API_KEY",
    envModel: "DEEPSEEK_MODEL",
    baseUrl: "https://api.deepseek.com"
  }
};

const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3600;
const SERPER_TIMEOUT_MS = 600;
const LLM_TIMEOUT_MS = 2500;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function resolveProvider() {
  const raw = String(process.env.LLM_PROVIDER || "gemini").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, raw)) {
    throw new Error("INVALID_LLM_PROVIDER");
  }
  return raw;
}

function resolveModel(provider) {
  const config = PROVIDERS[provider];
  const model = String(process.env[config.envModel] || process.env.LLM_MODEL || config.defaultModel).trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");
  return model;
}

function resolveApiKey(provider) {
  const config = PROVIDERS[provider];
  const key = process.env[config.envKey] || process.env.LLM_API_KEY;
  if (!key) throw new Error("MISSING_LLM_KEY");
  return key;
}

function aliceResponse(text, endSession = false, history = [], requestBody = {}) {
  const payload = {
    version: String(requestBody?.version || "1.0"),
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
  // Older Alice clients still expect session echoed from the request.
  if (requestBody?.session && typeof requestBody.session === "object") {
    payload.session = requestBody.session;
  }
  return payload;
}

function parseRequestBody(req) {
  const raw = req?.body;
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") return raw;
  return {};
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

function buildUserPrompt(text, searchContext) {
  return searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}

function mapHttpError(status) {
  if (status === 401 || status === 403) throw new Error("LLM_KEY_REJECTED");
  if (status === 429) throw new Error("LLM_QUOTA");
  throw new Error("LLM_REQUEST_FAILED");
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = resolveApiKey("gemini");
  const model = resolveModel("gemini");
  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));
  contents.push({ role: "user", parts: [{ text: buildUserPrompt(text, searchContext) }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 240
        }
      })
    },
    timeoutMs
  );

  if (!response.ok) {
    console.error("Gemini request failed with HTTP", response.status);
    mapHttpError(Number(response.status));
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("LLM_BLOCKED");
    throw new Error("LLM_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

async function askOpenAiCompatible(provider, text, history, searchContext, timeoutMs) {
  const config = PROVIDERS[provider];
  const key = resolveApiKey(provider);
  const model = resolveModel(provider);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...safeHistory(history).map(item => ({
      role: item.role === "model" ? "assistant" : "user",
      content: item.text
    })),
    { role: "user", content: buildUserPrompt(text, searchContext) }
  ];

  const { response, data } = await fetchJson(
    `${config.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.5,
        max_tokens: 240
      })
    },
    timeoutMs
  );

  if (!response.ok) {
    console.error(`${provider} request failed with HTTP`, response.status);
    mapHttpError(Number(response.status));
  }

  const choice = data?.choices?.[0];
  const answer = String(choice?.message?.content || "").trim();
  if (!answer) {
    if (data?.error?.code === "content_filter" || choice?.finish_reason === "content_filter") {
      throw new Error("LLM_BLOCKED");
    }
    throw new Error("LLM_EMPTY_RESPONSE");
  }
  if (choice?.finish_reason === "length") {
    console.warn(`${provider} reached the output token limit.`);
  }
  return answer;
}

async function askLlm(text, history, searchContext, timeoutMs) {
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const provider = resolveProvider();
  const budget = Math.min(LLM_TIMEOUT_MS, timeoutMs);

  if (provider === "gemini") {
    return askGemini(text, history, searchContext, budget);
  }
  return askOpenAiCompatible(provider, text, history, searchContext, budget);
}

function errorForUser(error) {
  switch (error?.message) {
    case "INVALID_LLM_PROVIDER":
      return "Сервер пока не настроен. Укажите LLM_PROVIDER=gemini, openai или deepseek.";
    case "MISSING_LLM_KEY":
      return "Сервер пока не настроен. Проверьте API-ключ выбранного провайдера в настройках Vercel.";
    case "INVALID_MODEL_NAME":
      return "Сервер пока не настроен. Проверьте имя модели в переменных окружения.";
    case "LLM_KEY_REJECTED":
      return "Не удалось подключиться к нейросети. Проверьте API-ключ в настройках Vercel.";
    case "LLM_QUOTA":
      return "Сейчас превышен лимит запросов к нейросети. Попробуйте немного позже.";
    case "LLM_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      let provider = "gemini";
      try {
        provider = resolveProvider();
      } catch {
        provider = "invalid";
      }
      return res.status(200).json({
        ok: true,
        service: "alice-llm-serper",
        provider,
        message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
      });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const startedAt = Date.now();
    const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
    const body = parseRequestBody(req);
    const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
    const oldHistory = safeHistory(body?.state?.session?.history);

    if (!text) {
      return res.status(200).json(aliceResponse(
        "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
        false,
        oldHistory,
        body
      ));
    }

    try {
      let searchContext = "";
      if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
        // Search has a very short budget because Alice expects a response within 4.5 seconds.
        searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2600)));
      }

      const answer = await askLlm(
        text,
        oldHistory,
        searchContext,
        Math.max(0, Math.min(LLM_TIMEOUT_MS, remainingMs() - 600))
      );

      const history = [
        ...oldHistory,
        { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
        { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
      ].slice(-MAX_HISTORY_MESSAGES);

      return res.status(200).json(aliceResponse(answer, false, history, body));
    } catch (error) {
      const safeError = error?.message === "AbortError" || error?.name === "AbortError"
        ? { message: "TIME_BUDGET_EXHAUSTED" }
        : error;
      console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
      return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory, body));
    }
  } catch (error) {
    console.error("Alice webhook crashed:", error?.message || error);
    return res.status(200).json(aliceResponse(
      "Не получилось обработать запрос. Попробуйте ещё раз чуть позже.",
      false,
      []
    ));
  }
}

export {
  aliceResponse,
  fitAliceText,
  isSearchIntent,
  parseRequestBody,
  resolveProvider,
  safeHistory
};
