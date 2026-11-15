const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Official Gemini REST API bypass literal for synthetic/migrated functionCall parts
const BYPASS_THOUGHT_SIG = 'skip_thought_signature_validator';

// ==========================================
// 1. Dynamic API Key Loader
// ==========================================
function getApiKeys() {
  const keysPath = path.join(__dirname, 'keys.json');
  if (!fs.existsSync(keysPath)) {
    return { keys: [], error: 'keys.json file not found in root directory.' };
  }
  try {
    const rawData = fs.readFileSync(keysPath, 'utf8');
    const parsed = JSON.parse(rawData);
    if (!Array.isArray(parsed)) {
      return { keys: [], error: 'keys.json must contain a JSON array of API key strings.' };
    }
    const validKeys = parsed.filter((k) => typeof k === 'string' && k.trim().length > 0);
    if (validKeys.length === 0) {
      return { keys: [], error: 'keys.json is empty or contains no valid API key strings.' };
    }
    return { keys: validKeys, error: null };
  } catch (err) {
    return { keys: [], error: `Failed to read or parse keys.json: ${err.message}` };
  }
}

// ==========================================
// 2. Models & Per-Model Quota State
// ==========================================
const MODELS = [
  'gemini-4-hydrogen',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash-lite',
];

const cooldowns = Object.fromEntries(MODELS.map((m) => [m, {}]));
const consecutive429s = Object.fromEntries(MODELS.map((m) => [m, {}]));
const activeKeyPerModel = Object.fromEntries(MODELS.map((m) => [m, 0]));

let activeModel = 'gemini-4-hydrogen';

// ==========================================
// 3. Quota Timing & Status Helpers
// ==========================================
function getNextMidnightPT() {
  const now = new Date();
  const ptDateString = now.toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [month, day, year] = ptDateString.split('/').map(Number);

  let candidate = new Date(Date.UTC(year, month - 1, day + 1, 7, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(candidate);

  const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute').value, 10);

  const offsetMinutes = hour * 60 + minute;
  return candidate.getTime() - offsetMinutes * 60 * 1000;
}

function getKeyStatus(model, idx) {
  const item = cooldowns[model]?.[idx];
  const now = Date.now();
  if (item && item.until > now) {
    const secondsLeft = Math.ceil((item.until - now) / 1000);
    return {
      status: item.type,
      secondsLeft,
      isDaily: item.type === 'daily_exhausted',
    };
  }
  if (cooldowns[model]?.[idx]) {
    delete cooldowns[model][idx];
  }
  return { status: 'available', secondsLeft: 0, isDaily: false };
}

function getModelsStatus(keysCount) {
  const result = {};
  for (const model of MODELS) {
    const list = [];
    for (let i = 0; i < keysCount; i++) {
      const { status, secondsLeft, isDaily } = getKeyStatus(model, i);
      list.push({
        index: i + 1,
        status,
        secondsLeft,
        isDaily,
      });
    }
    result[model] = list;
  }
  return result;
}

// ==========================================
// 4. OpenAI <-> Native Gemini v1beta Translator
// ==========================================
function cleanGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(cleanGeminiSchema);

  const cleaned = {};
  const allowedKeys = new Set([
    'type',
    'format',
    'title',
    'description',
    'nullable',
    'enum',
    'maxItems',
    'minItems',
    'properties',
    'required',
    'propertyOrdering',
    'items',
    'anyOf',
  ]);

  for (const [k, v] of Object.entries(schema)) {
    if (!allowedKeys.has(k)) continue;
    if (k === 'type' && Array.isArray(v)) {
      const nonNull = v.find((t) => t !== 'null') || 'STRING';
      cleaned.type = nonNull.toUpperCase();
      if (v.includes('null')) cleaned.nullable = true;
    } else if (k === 'type' && typeof v === 'string') {
      cleaned.type = v.toUpperCase();
    } else if (k === 'properties' && v && typeof v === 'object') {
      cleaned.properties = {};
      for (const [propName, propVal] of Object.entries(v)) {
        cleaned.properties[propName] = cleanGeminiSchema(propVal);
      }
    } else {
      cleaned[k] = cleanGeminiSchema(v);
    }
  }

  return cleaned;
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        return '';
      })
      .join('');
  }
  return '';
}

function buildGeminiPartsFromUserOrAssistant(content) {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const parts = [];
  for (const item of content) {
    if (typeof item === 'string' && item) {
      parts.push({ text: item });
    } else if (item?.type === 'text' && item.text) {
      parts.push({ text: item.text });
    } else if (item?.type === 'image_url' && item.image_url?.url) {
      const url = item.image_url.url;
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2],
          },
        });
      }
    }
  }
  return parts;
}

function resolveThoughtSignature(tc) {
  let candidate = null;
  if (typeof tc.id === 'string' && tc.id.includes('__sig__')) {
    candidate = tc.id.split('__sig__')[1] || null;
  } else if (tc.extra_content?.google?.thought_signature) {
    candidate = tc.extra_content.google.thought_signature;
  } else if (tc.thought_signature) {
    candidate = tc.thought_signature;
  }

  if (!candidate || candidate === 'skip_thought_signature_validation') {
    return BYPASS_THOUGHT_SIG;
  }
  return candidate;
}

function openAiToGeminiRequest(rawBody) {
  const systemTexts = [];
  const contents = [];
  const toolCallIdToName = new Map();

  const messages = Array.isArray(rawBody.messages) ? rawBody.messages : [];

  for (const msg of messages) {
    const role = msg.role;

    // 1. System / Developer instructions
    if (role === 'system' || role === 'developer') {
      const txt = extractTextContent(msg.content);
      if (txt.trim()) systemTexts.push(txt);
      continue;
    }

    // 2. Tool results -> Gemini user turn with functionResponse
    if (role === 'tool') {
      const callId = msg.tool_call_id || '';
      const fnName = toolCallIdToName.get(callId) || msg.name || 'unknown_tool';
      const rawOut = extractTextContent(msg.content);

      let responseObj;
      try {
        const parsed = JSON.parse(rawOut);
        responseObj =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : { result: parsed };
      } catch (_) {
        responseObj = { result: rawOut };
      }

      const fnRespPart = {
        functionResponse: {
          name: fnName,
          response: responseObj,
        },
      };

      const prev = contents[contents.length - 1];
      if (prev && prev.role === 'user' && prev.parts.some((p) => p.functionResponse)) {
        prev.parts.push(fnRespPart);
      } else {
        contents.push({ role: 'user', parts: [fnRespPart] });
      }
      continue;
    }

    // 3. Assistant turn -> Gemini 'model' turn (with official skip_thought_signature_validator)
    if (role === 'assistant') {
      const parts = buildGeminiPartsFromUserOrAssistant(msg.content);

      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc.function) continue;
          const fnName = tc.function.name;
          if (tc.id) toolCallIdToName.set(tc.id, fnName);

          let args = {};
          if (typeof tc.function.arguments === 'string') {
            try {
              args = JSON.parse(tc.function.arguments || '{}');
            } catch (_) {
              args = {};
            }
          } else if (tc.function.arguments && typeof tc.function.arguments === 'object') {
            args = tc.function.arguments;
          }

          parts.push({
            functionCall: {
              name: fnName,
              args,
            },
            thoughtSignature: resolveThoughtSignature(tc),
          });
        }
      }

      if (parts.length > 0) {
        const prev = contents[contents.length - 1];
        if (prev && prev.role === 'model') {
          prev.parts.push(...parts);
        } else {
          contents.push({ role: 'model', parts });
        }
      }
      continue;
    }

    // 4. User turn
    const userParts = buildGeminiPartsFromUserOrAssistant(msg.content);
    if (userParts.length === 0) userParts.push({ text: ' ' });

    const prev = contents[contents.length - 1];
    if (prev && prev.role === 'user' && !prev.parts.some((p) => p.functionResponse)) {
      prev.parts.push(...userParts);
    } else {
      contents.push({ role: 'user', parts: userParts });
    }
  }

  const geminiPayload = { contents };

  if (systemTexts.length > 0) {
    geminiPayload.systemInstruction = {
      parts: [{ text: systemTexts.join('\n\n') }],
    };
  }

  if (Array.isArray(rawBody.tools) && rawBody.tools.length > 0) {
    const declarations = [];
    for (const t of rawBody.tools) {
      if (t.type === 'function' && t.function) {
        const decl = {
          name: t.function.name,
          description: t.function.description || '',
        };
        if (t.function.parameters && Object.keys(t.function.parameters).length > 0) {
          decl.parameters = cleanGeminiSchema(t.function.parameters);
        }
        declarations.push(decl);
      }
    }
    if (declarations.length > 0) {
      geminiPayload.tools = [{ functionDeclarations: declarations }];
    }
  }

  const generationConfig = {};
  if (typeof rawBody.temperature === 'number') generationConfig.temperature = rawBody.temperature;
  if (typeof rawBody.top_p === 'number') generationConfig.topP = rawBody.top_p;
  const maxOut = rawBody.max_tokens || rawBody.max_completion_tokens;
  if (typeof maxOut === 'number') generationConfig.maxOutputTokens = maxOut;
  if (Array.isArray(rawBody.stop)) generationConfig.stopSequences = rawBody.stop;
  else if (typeof rawBody.stop === 'string') generationConfig.stopSequences = [rawBody.stop];

  if (Object.keys(generationConfig).length > 0) {
    geminiPayload.generationConfig = generationConfig;
  }

  return geminiPayload;
}

function geminiCandidateToOpenAiMessage(candidate, toolCallCounterStart = 0) {
  const parts = candidate?.content?.parts || [];
  let text = '';
  const toolCalls = [];
  let counter = toolCallCounterStart;

  for (const part of parts) {
    if (part.thought) continue;
    if (typeof part.text === 'string') {
      text += part.text;
    } else if (part.functionCall) {
      const sig = part.thoughtSignature || BYPASS_THOUGHT_SIG;
      const callId = `call_${Date.now()}_${counter++}__sig__${sig}`;
      toolCalls.push({
        index: toolCalls.length,
        id: callId,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
    }
  }

  const finishMap = {
    STOP: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    MAX_TOKENS: 'length',
    SAFETY: 'content_filter',
    RECITATION: 'content_filter',
  };
  const finishReason =
    toolCalls.length > 0
      ? 'tool_calls'
      : finishMap[candidate?.finishReason] || (candidate?.finishReason ? 'stop' : null);

  return { text, toolCalls, finishReason, nextCounter: counter };
}

// ==========================================
// 5. Error Extraction & Rotation Classifier
// ==========================================
async function extractErrorData(err) {
  if (!err.response || !err.response.data) {
    return err.message || 'Unknown network error';
  }
  const data = err.response.data;

  if (typeof data.pipe === 'function' || typeof data.on === 'function') {
    return new Promise((resolve) => {
      let chunks = '';
      data.on('data', (c) => (chunks += c.toString('utf-8')));
      data.on('end', () => {
        try {
          resolve(JSON.parse(chunks));
        } catch (_) {
          resolve(chunks);
        }
      });
      data.on('error', () => resolve(err.message));
    });
  }

  if (Buffer.isBuffer(data)) {
    try {
      return JSON.parse(data.toString('utf-8'));
    } catch (_) {
      return data.toString('utf-8');
    }
  }

  return data;
}

function classifyRotationError(status, errorData, isTimeout) {
  if (isTimeout) {
    return { rotate: true, isDaily: false, reason: 'Timeout' };
  }

  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return { rotate: false, isDaily: false, reason: `HTTP ${status}` };
  }

  const text = typeof errorData === 'string' ? errorData : JSON.stringify(errorData || {});
  const lowerText = text.toLowerCase();

  const isDaily =
    text.includes('PerDay') ||
    text.includes('RequestsPerDay') ||
    lowerText.includes('per day') ||
    lowerText.includes('daily limit');

  const isQuotaOrOverload =
    status === 429 ||
    status === 503 ||
    status === 502 ||
    status === 500 ||
    text.includes('RESOURCE_EXHAUSTED') ||
    lowerText.includes('quota exceeded') ||
    lowerText.includes('rate limit') ||
    lowerText.includes('high demand') ||
    text.includes('UNAVAILABLE') ||
    lowerText.includes('overloaded');

  if (isQuotaOrOverload) {
    return { rotate: true, isDaily, reason: status ? `HTTP ${status}` : 'Quota/Overload' };
  }

  return { rotate: false, isDaily: false, reason: `HTTP ${status || 'Unknown'}` };
}

// ==========================================
// 6. Status & Widget Control Endpoints
// ==========================================
app.get('/status', (req, res) => {
  const { keys, error } = getApiKeys();
  const keysCount = keys.length;
  if (keysCount > 0 && activeKeyPerModel[activeModel] >= keysCount) {
    activeKeyPerModel[activeModel] = 0;
  }
  const currentActiveKeyIdx = keysCount > 0 ? activeKeyPerModel[activeModel] + 1 : 1;

  res.json({
    activeModel,
    activeKeyIndex: currentActiveKeyIdx,
    models: getModelsStatus(keysCount),
    ...(error ? { keysError: error } : {}),
  });
});

app.post('/select', (req, res) => {
  const { model, keyIndex, reset } = req.body || {};
  const { keys } = getApiKeys();
  const keysCount = keys.length;

  if (model && MODELS.includes(model)) {
    activeModel = model;
  }
  const targetModel = activeModel;

  if (typeof keyIndex === 'number' && keysCount > 0) {
    const idx = keyIndex >= 1 && keyIndex <= keysCount ? keyIndex - 1 : keyIndex;
    if (idx >= 0 && idx < keysCount) {
      activeKeyPerModel[targetModel] = idx;
      if (reset) {
        delete cooldowns[targetModel][idx];
        consecutive429s[targetModel][idx] = 0;
      }
    }
  } else if (reset) {
    cooldowns[targetModel] = {};
    consecutive429s[targetModel] = {};
  }

  const currentActiveKeyIdx = keysCount > 0 ? activeKeyPerModel[targetModel] + 1 : 1;

  return res.json({
    activeModel,
    activeKeyIndex: currentActiveKeyIdx,
    models: getModelsStatus(keysCount),
  });
});

// ==========================================
// 7. OpenAI-Compatible Chat Completions Route
// ==========================================
app.post('/v1/chat/completions', async (req, res) => {
  const { keys: API_KEYS, error: keysError } = getApiKeys();

  if (keysError || API_KEYS.length === 0) {
    const errorMsg =
      keysError || 'keys.json is empty or missing. Please populate keys.json with your Gemini API keys.';
    console.error(`[Proxy Error] ${errorMsg}`);
    return res.status(500).json({
      error: { message: errorMsg, type: 'configuration_error', code: 500 },
    });
  }

  const isStream = Boolean(req.body?.stream);
  const geminiPayload = openAiToGeminiRequest(req.body || {});
  const currentModel = activeModel;
  const totalKeys = API_KEYS.length;

  if (activeKeyPerModel[currentModel] >= totalKeys) {
    activeKeyPerModel[currentModel] = 0;
  }
  const startIdx = activeKeyPerModel[currentModel];

  for (let offset = 0; offset < totalKeys; offset++) {
    const idx = (startIdx + offset) % totalKeys;
    const keyInfo = getKeyStatus(currentModel, idx);

    if (keyInfo.status !== 'available') {
      continue;
    }

    activeKeyPerModel[currentModel] = idx;
    const currentKey = API_KEYS[idx];

    const method = isStream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:${method}`;

    try {
      const response = await axios.post(url, geminiPayload, {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': currentKey,
          'Accept-Encoding': 'identity',
        },
        responseType: isStream ? 'stream' : 'json',
        timeout: 180000,
      });

      consecutive429s[currentModel][idx] = 0;
      const completionId = `chatcmpl-${Date.now()}`;
      const createdTs = Math.floor(Date.now() / 1000);

      if (!isStream) {
        const candidate = response.data?.candidates?.[0] || {};
        const { text, toolCalls, finishReason } = geminiCandidateToOpenAiMessage(candidate, 0);

        const message = { role: 'assistant', content: text || null };
        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls.map(({ index, ...rest }) => rest);
        }

        return res.json({
          id: completionId,
          object: 'chat.completion',
          created: createdTs,
          model: currentModel,
          choices: [
            {
              index: 0,
              message,
              finish_reason: finishReason || 'stop',
            },
          ],
          usage: {
            prompt_tokens: response.data?.usageMetadata?.promptTokenCount || 0,
            completion_tokens: response.data?.usageMetadata?.candidatesTokenCount || 0,
            total_tokens: response.data?.usageMetadata?.totalTokenCount || 0,
          },
        });
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      let toolCallCounter = 0;
      let sawToolCalls = false;
      let sentRole = false;

      const sendChunk = (delta, finishReason = null, usage = null) => {
        const chunkObj = {
          id: completionId,
          object: 'chat.completion.chunk',
          created: createdTs,
          model: currentModel,
          choices: [
            {
              index: 0,
              delta,
              finish_reason: finishReason,
            },
          ],
        };
        if (usage) chunkObj.usage = usage;
        res.write(`data: ${JSON.stringify(chunkObj)}\n\n`);
      };

      response.data.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const candidate = parsed?.candidates?.[0];
            if (!candidate) continue;

            const { text, toolCalls, finishReason, nextCounter } = geminiCandidateToOpenAiMessage(
              candidate,
              toolCallCounter
            );
            toolCallCounter = nextCounter;

            if (!sentRole) {
              sendChunk({ role: 'assistant', content: '' }, null);
              sentRole = true;
            }

            if (text) {
              sendChunk({ content: text }, null);
            }

            if (toolCalls.length > 0) {
              sawToolCalls = true;
              sendChunk({ tool_calls: toolCalls }, null);
            }

            if (finishReason) {
              const usage = parsed?.usageMetadata
                ? {
                    prompt_tokens: parsed.usageMetadata.promptTokenCount || 0,
                    completion_tokens: parsed.usageMetadata.candidatesTokenCount || 0,
                    total_tokens: parsed.usageMetadata.totalTokenCount || 0,
                  }
                : null;
              sendChunk({}, sawToolCalls ? 'tool_calls' : finishReason, usage);
            }
          } catch (_) {
            // Ignore partial JSON lines until complete
          }
        }
      });

      response.data.on('end', () => {
        res.write('data: [DONE]\n\n');
        res.end();
      });

      response.data.on('error', (streamErr) => {
        console.error('[Stream Error]:', streamErr.message);
        if (!res.headersSent) {
          res.status(500).end();
        } else {
          res.end();
        }
      });

      return;
    } catch (err) {
      const status = err.response?.status || null;
      const errorData = await extractErrorData(err);
      const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
      const classification = classifyRotationError(status, errorData, isTimeout);

      if (classification.rotate) {
        const prevStreak = consecutive429s[currentModel][idx] || 0;
        const msgSummary =
          errorData?.error?.message ||
          (typeof errorData === 'string' ? errorData.slice(0, 140) : classification.reason);

        if (classification.isDaily || (status === 429 && prevStreak >= 1)) {
          cooldowns[currentModel][idx] = {
            type: 'daily_exhausted',
            until: getNextMidnightPT(),
          };
          console.warn(
            `[Rotate -> Daily Lock] ${currentModel} | Key #${idx + 1} (${classification.reason}): ${msgSummary}`
          );
        } else {
          cooldowns[currentModel][idx] = {
            type: 'rate_limited',
            until: Date.now() + 60000,
          };
          if (status === 429) {
            consecutive429s[currentModel][idx] = prevStreak + 1;
          }
          console.warn(
            `[Rotate -> 60s Cooldown] ${currentModel} | Key #${idx + 1} (${classification.reason}): ${msgSummary}`
          );
        }

        activeKeyPerModel[currentModel] = (idx + 1) % totalKeys;
        continue;
      }

      console.error(`\n================== [Proxy API Error] ==================`);
      console.error(`Status: ${status || 500} | Model: ${currentModel} | Key #${idx + 1}`);
      console.error(
        `Details:`,
        typeof errorData === 'object' ? JSON.stringify(errorData, null, 2) : errorData
      );
      console.error(`=======================================================\n`);

      return res.status(status || 500).json({
        error: {
          message:
            errorData?.error?.message ||
            (typeof errorData === 'string' ? errorData : err.message),
          type: 'upstream_error',
          code: status || 500,
          details: errorData,
        },
      });
    }
  }

  console.warn(`[Proxy 429] All ${totalKeys} keys for ${currentModel} are currently in cooldown.`);
  return res.status(429).json({
    error: {
      message: `All ${totalKeys} API keys for ${currentModel} are currently rate-limited or daily-exhausted.`,
      type: 'model_exhausted',
      code: 429,
    },
  });
});

// ==========================================
// 8. Server Startup & Process Guards
// ==========================================
const PORT = 8080;
app.listen(PORT, () => {
  console.log(`Gemini Native-Adapter Proxy listening on http://localhost:${PORT}/v1`);
  console.log(`Status endpoint: http://localhost:${PORT}/status`);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]:', reason);
});