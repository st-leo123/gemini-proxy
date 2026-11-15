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
// 4. Shared Schema & Signature Helpers
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
    } else if (k === 'items' && v && typeof v === 'object') {
      cleaned.items = Array.isArray(v)
        ? cleanGeminiSchema(v[0] || { type: 'STRING' })
        : cleanGeminiSchema(v);
    } else {
      cleaned[k] = cleanGeminiSchema(v);
    }
  }

  // Gemini strictly requires ARRAY types to define `items` with a valid `type`
  if (cleaned.type === 'ARRAY') {
    if (!cleaned.items || typeof cleaned.items !== 'object' || Object.keys(cleaned.items).length === 0) {
      cleaned.items = { type: 'STRING' };
    } else if (!cleaned.items.type && !cleaned.items.anyOf) {
      cleaned.items.type = 'STRING';
    }
  }

  // Gemini strictly requires OBJECT types to have non-empty `properties` (or omit properties if open-ended)
  if (cleaned.type === 'OBJECT' && cleaned.properties && Object.keys(cleaned.properties).length === 0) {
    delete cleaned.properties;
  }

  return cleaned;
}

function resolveThoughtSignatureFromId(idStr, extraObj = null) {
  let candidate = null;
  if (typeof idStr === 'string' && idStr.includes('__sig__')) {
    candidate = idStr.split('__sig__')[1] || null;
  } else if (extraObj?.extra_content?.google?.thought_signature) {
    candidate = extraObj.extra_content.google.thought_signature;
  } else if (extraObj?.thought_signature) {
    candidate = extraObj.thought_signature;
  }

  if (!candidate || candidate === 'skip_thought_signature_validation') {
    return BYPASS_THOUGHT_SIG;
  }
  return candidate;
}

// ==========================================
// 5A. OpenAI <-> Native Gemini Translator (Cline)
// ==========================================
function extractOpenAiTextContent(content) {
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

function buildGeminiPartsFromOpenAi(content) {
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

function openAiToGeminiRequest(rawBody) {
  const systemTexts = [];
  const contents = [];
  const toolCallIdToName = new Map();
  const messages = Array.isArray(rawBody.messages) ? rawBody.messages : [];

  for (const msg of messages) {
    const role = msg.role;

    if (role === 'system' || role === 'developer') {
      const txt = extractOpenAiTextContent(msg.content);
      if (txt.trim()) systemTexts.push(txt);
      continue;
    }

    if (role === 'tool') {
      const callId = msg.tool_call_id || '';
      const fnName = toolCallIdToName.get(callId) || msg.name || 'unknown_tool';
      const rawOut = extractOpenAiTextContent(msg.content);

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

    if (role === 'assistant') {
      const parts = buildGeminiPartsFromOpenAi(msg.content);

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
            thoughtSignature: resolveThoughtSignatureFromId(tc.id, tc),
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

    const userParts = buildGeminiPartsFromOpenAi(msg.content);
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
// 5B. Anthropic Messages <-> Native Gemini Translator (Claude Code)
// ==========================================
function extractAnthropicSystemText(systemField) {
  if (typeof systemField === 'string') return systemField;
  if (Array.isArray(systemField)) {
    return systemField
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block?.type === 'text') return block.text || '';
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function extractAnthropicToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b?.type === 'text') return b.text || '';
        return JSON.stringify(b);
      })
      .join('\n');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

function anthropicToGeminiRequest(rawBody) {
  const contents = [];
  const toolUseIdToName = new Map();
  const messages = Array.isArray(rawBody.messages) ? rawBody.messages : [];

  for (const msg of messages) {
    const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
    const blocks = Array.isArray(msg.content)
      ? msg.content
      : typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : [];

    const parts = [];

    for (const block of blocks) {
      if (!block) continue;

      if (block.type === 'text' && block.text) {
        parts.push({ text: block.text });
      } else if (block.type === 'image' && block.source?.type === 'base64') {
        parts.push({
          inlineData: {
            mimeType: block.source.media_type || 'image/png',
            data: block.source.data,
          },
        });
      } else if (block.type === 'tool_use') {
        if (block.id && block.name) {
          toolUseIdToName.set(block.id, block.name);
        }
        parts.push({
          functionCall: {
            name: block.name,
            args: block.input && typeof block.input === 'object' ? block.input : {},
          },
          thoughtSignature: resolveThoughtSignatureFromId(block.id),
        });
      } else if (block.type === 'tool_result') {
        const fnName = toolUseIdToName.get(block.tool_use_id) || 'unknown_tool';
        const rawOut = extractAnthropicToolResultContent(block.content);
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

        parts.push({
          functionResponse: {
            name: fnName,
            response: responseObj,
          },
        });
      }
      // Skip 'thinking' / 'redacted_thinking' blocks from Claude Code history
    }

    if (parts.length === 0) {
      parts.push({ text: ' ' });
    }

    const prev = contents[contents.length - 1];
    if (prev && prev.role === geminiRole) {
      prev.parts.push(...parts);
    } else {
      contents.push({ role: geminiRole, parts });
    }
  }

  const geminiPayload = { contents };

  const systemText = extractAnthropicSystemText(rawBody.system);
  if (systemText.trim()) {
    geminiPayload.systemInstruction = {
      parts: [{ text: systemText }],
    };
  }

  if (Array.isArray(rawBody.tools) && rawBody.tools.length > 0) {
    const declarations = [];
    for (const t of rawBody.tools) {
      if (!t?.name) continue;
      const decl = {
        name: t.name,
        description: t.description || '',
      };
      if (t.input_schema && Object.keys(t.input_schema).length > 0) {
        decl.parameters = cleanGeminiSchema(t.input_schema);
      }
      declarations.push(decl);
    }
    if (declarations.length > 0) {
      geminiPayload.tools = [{ functionDeclarations: declarations }];
    }
  }

  const generationConfig = {};
  if (typeof rawBody.temperature === 'number') generationConfig.temperature = rawBody.temperature;
  if (typeof rawBody.top_p === 'number') generationConfig.topP = rawBody.top_p;
  if (typeof rawBody.top_k === 'number') generationConfig.topK = rawBody.top_k;
  if (typeof rawBody.max_tokens === 'number') generationConfig.maxOutputTokens = rawBody.max_tokens;
  if (Array.isArray(rawBody.stop_sequences)) generationConfig.stopSequences = rawBody.stop_sequences;

  if (Object.keys(generationConfig).length > 0) {
    geminiPayload.generationConfig = generationConfig;
  }

  return geminiPayload;
}

function geminiCandidateToAnthropicContent(candidate, counterStart = 0) {
  const parts = candidate?.content?.parts || [];
  const contentBlocks = [];
  let counter = counterStart;
  let hasToolUse = false;

  for (const part of parts) {
    if (part.thought) continue;
    if (typeof part.text === 'string' && part.text.length > 0) {
      contentBlocks.push({
        type: 'text',
        text: part.text,
      });
    } else if (part.functionCall) {
      hasToolUse = true;
      const sig = part.thoughtSignature || BYPASS_THOUGHT_SIG;
      const toolUseId = `toolu_${Date.now()}_${counter++}__sig__${sig}`;
      contentBlocks.push({
        type: 'tool_use',
        id: toolUseId,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      });
    }
  }

  const stopMap = {
    STOP: hasToolUse ? 'tool_use' : 'end_turn',
    MAX_TOKENS: 'max_tokens',
    SAFETY: 'end_turn',
    RECITATION: 'end_turn',
  };
  const stopReason = hasToolUse
    ? 'tool_use'
    : stopMap[candidate?.finishReason] || (candidate?.finishReason ? 'end_turn' : null);

  return { contentBlocks, stopReason, nextCounter: counter };
}

// ==========================================
// 6. Error Extraction & Shared Key Rotation Executor
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

async function executeGeminiWithRotation(geminiPayload, isStream, clientLabel) {
  const { keys: API_KEYS, error: keysError } = getApiKeys();

  if (keysError || API_KEYS.length === 0) {
    const errorMsg =
      keysError || 'keys.json is empty or missing. Please populate keys.json with your Gemini API keys.';
    console.error(`[Proxy Error] ${errorMsg}`);
    return { ok: false, status: 500, errorType: 'configuration_error', message: errorMsg };
  }

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
        timeout: 45000,
      });

      consecutive429s[currentModel][idx] = 0;
      return { ok: true, response, currentModel };
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
            `[${clientLabel} | Rotate -> Daily Lock] ${currentModel} | Key #${idx + 1} (${classification.reason}): ${msgSummary}`
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
            `[${clientLabel} | Rotate -> 60s Cooldown] ${currentModel} | Key #${idx + 1} (${classification.reason}): ${msgSummary}`
          );
        }

        activeKeyPerModel[currentModel] = (idx + 1) % totalKeys;
        continue;
      }

      console.error(`\n================== [${clientLabel} | Proxy API Error] ==================`);
      console.error(`Status: ${status || 500} | Model: ${currentModel} | Key #${idx + 1}`);
      console.error(
        `Details:`,
        typeof errorData === 'object' ? JSON.stringify(errorData, null, 2) : errorData
      );
      console.error(`========================================================================\n`);

      return {
        ok: false,
        status: status || 500,
        errorType: 'upstream_error',
        message:
          errorData?.error?.message ||
          (typeof errorData === 'string' ? errorData : err.message),
        details: errorData,
      };
    }
  }

  console.warn(`[${clientLabel} | Proxy 429] All ${totalKeys} keys for ${currentModel} are in cooldown.`);
  return {
    ok: false,
    status: 429,
    errorType: 'model_exhausted',
    message: `All ${totalKeys} API keys for ${currentModel} are currently rate-limited or daily-exhausted.`,
  };
}

// ==========================================
// 7. Status & Widget Control Endpoints
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
// 8A. OpenAI-Compatible Route (Cline)
// ==========================================
app.post('/v1/chat/completions', async (req, res) => {
  const isStream = Boolean(req.body?.stream);
  const geminiPayload = openAiToGeminiRequest(req.body || {});
  const result = await executeGeminiWithRotation(geminiPayload, isStream, 'Cline');

  if (!result.ok) {
    return res.status(result.status).json({
      error: {
        message: result.message,
        type: result.errorType,
        code: result.status,
        ...(result.details ? { details: result.details } : {}),
      },
    });
  }

  const { response, currentModel } = result;
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
        // Wait for complete JSON frame
      }
    }
  });

  response.data.on('end', () => {
    res.write('data: [DONE]\n\n');
    res.end();
  });

  response.data.on('error', (streamErr) => {
    console.error('[Cline Stream Error]:', streamErr.message);
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
});

// ==========================================
// 8B. Anthropic Messages Routes (Claude Code)
// ==========================================
app.post('/v1/messages/count_tokens', (req, res) => {
  const approxTokens = Math.ceil(JSON.stringify(req.body || {}).length / 4);
  res.json({ input_tokens: approxTokens });
});

app.post('/v1/messages', async (req, res) => {
  const isStream = Boolean(req.body?.stream);
  const geminiPayload = anthropicToGeminiRequest(req.body || {});
  const result = await executeGeminiWithRotation(geminiPayload, isStream, 'ClaudeCode');

  if (!result.ok) {
    return res.status(result.status).json({
      type: 'error',
      error: {
        type: result.status === 429 ? 'rate_limit_error' : 'api_error',
        message: result.message,
      },
    });
  }

  const { response, currentModel } = result;
  const msgId = `msg_${Date.now()}`;

  if (!isStream) {
    const candidate = response.data?.candidates?.[0] || {};
    const { contentBlocks, stopReason } = geminiCandidateToAnthropicContent(candidate, 0);

    return res.json({
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: currentModel,
      content: contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: '' }],
      stop_reason: stopReason || 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: response.data?.usageMetadata?.promptTokenCount || 0,
        output_tokens: response.data?.usageMetadata?.candidatesTokenCount || 0,
      },
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendAnthropicEvent = (eventName, payload) => {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  sendAnthropicEvent('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: currentModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let buffer = '';
  let blockIndex = 0;
  let activeTextBlockOpen = false;
  let toolCounter = 0;
  let sawToolUse = false;
  let finalStopReason = 'end_turn';
  let outputTokens = 0;

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
        if (parsed?.usageMetadata?.candidatesTokenCount) {
          outputTokens = parsed.usageMetadata.candidatesTokenCount;
        }

        const candidate = parsed?.candidates?.[0];
        if (!candidate) continue;

        const { contentBlocks, stopReason, nextCounter } = geminiCandidateToAnthropicContent(
          candidate,
          toolCounter
        );
        toolCounter = nextCounter;

        for (const block of contentBlocks) {
          if (block.type === 'text') {
            if (!activeTextBlockOpen) {
              sendAnthropicEvent('content_block_start', {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'text', text: '' },
              });
              activeTextBlockOpen = true;
            }
            sendAnthropicEvent('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'text_delta', text: block.text },
            });
          } else if (block.type === 'tool_use') {
            if (activeTextBlockOpen) {
              sendAnthropicEvent('content_block_stop', {
                type: 'content_block_stop',
                index: blockIndex,
              });
              blockIndex++;
              activeTextBlockOpen = false;
            }

            sawToolUse = true;
            sendAnthropicEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: {},
              },
            });
            sendAnthropicEvent('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(block.input || {}),
              },
            });
            sendAnthropicEvent('content_block_stop', {
              type: 'content_block_stop',
              index: blockIndex,
            });
            blockIndex++;
          }
        }

        if (stopReason) {
          finalStopReason = sawToolUse ? 'tool_use' : stopReason;
        }
      } catch (_) {
        // Wait for complete JSON frame
      }
    }
  });

  response.data.on('end', () => {
    if (activeTextBlockOpen) {
      sendAnthropicEvent('content_block_stop', {
        type: 'content_block_stop',
        index: blockIndex,
      });
      blockIndex++;
    }

    sendAnthropicEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: sawToolUse ? 'tool_use' : finalStopReason,
        stop_sequence: null,
      },
      usage: { output_tokens: outputTokens },
    });

    sendAnthropicEvent('message_stop', { type: 'message_stop' });
    res.end();
  });

  response.data.on('error', (streamErr) => {
    console.error('[ClaudeCode Stream Error]:', streamErr.message);
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
});

// ==========================================
// 9. Server Startup & Process Guards
// ==========================================
const PORT = 8080;
app.listen(PORT, () => {
  console.log(`Gemini Dual-Protocol Proxy listening on http://localhost:${PORT}`);
  console.log(`  - Cline (OpenAI):       http://localhost:${PORT}/v1/chat/completions`);
  console.log(`  - Claude Code:          http://localhost:${PORT}/v1/messages`);
  console.log(`  - Widget Status:        http://localhost:${PORT}/status`);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]:', reason);
});