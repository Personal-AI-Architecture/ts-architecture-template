// @ts-nocheck

const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.cwd();

const REQUIRED_FILES = [
  "specs/openapi/gateway-api.yaml",
  "specs/openapi/gateway-engine.yaml",
  "specs/openapi/model-api.yaml",
  "specs/schemas/message.json"
];

const REQUIRED_GATEWAY_STREAM_EVENTS = [
  "text-delta",
  "tool-call",
  "tool-result",
  "approval-request",
  "approval-result",
  "done",
  "error"
];

const REQUIRED_ENGINE_EVENTS = ["text-delta", "tool-call", "tool-result", "done", "error"];

const REQUIRED_MESSAGE_ROLES = ["system", "user", "assistant", "tool"];

function leadingSpaces(value) {
  let i = 0;
  while (i < value.length && value[i] === " ") {
    i += 1;
  }
  return i;
}

function cleanItem(value) {
  return value.trim().replace(/^-\s*/, "").replace(/^['\"]|['\"]$/g, "");
}

function extractBlockByHeader(lines, headerRegex, stopRegexes) {
  const start = lines.findIndex((line) => headerRegex.test(line));
  if (start === -1) {
    return "";
  }

  const output = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (stopRegexes.some((regex) => regex.test(line))) {
      break;
    }
    output.push(line);
  }

  return output.join("\n");
}

function extractPathBlock(yaml, pathName) {
  const lines = yaml.split(/\r?\n/);
  const escaped = pathName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return extractBlockByHeader(lines, new RegExp(`^\\s{2}${escaped}:\\s*$`), [
    /^\s{2}\/[\S]+:\s*$/,
    /^components:\s*$/
  ]);
}

function extractSchemaBlock(yaml, schemaName) {
  const lines = yaml.split(/\r?\n/);
  const escaped = schemaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return extractBlockByHeader(lines, new RegExp(`^\\s{4}${escaped}:\\s*$`), [
    /^\s{4}[A-Za-z0-9_-]+:\s*$/,
    /^\s{2}\S.*$/
  ]);
}

function extractListItemsUnderKey(block, keyName) {
  const lines = block.split(/\r?\n/);
  const keyIndex = lines.findIndex((line) => line.trim() === `${keyName}:`);
  if (keyIndex === -1) {
    return [];
  }

  const keyIndent = leadingSpaces(lines[keyIndex]);
  const values = [];

  for (let i = keyIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      continue;
    }

    const indent = leadingSpaces(line);
    if (indent <= keyIndent) {
      break;
    }

    if (line.trim().startsWith("- ")) {
      values.push(cleanItem(line));
    }
  }

  return values;
}

function extractPropertyEnum(schemaBlock, propertyName) {
  const lines = schemaBlock.split(/\r?\n/);
  const propertyIndex = lines.findIndex((line) => line.trim() === `${propertyName}:`);
  if (propertyIndex === -1) {
    return [];
  }

  const propertyIndent = leadingSpaces(lines[propertyIndex]);
  let enumIndex = -1;

  for (let i = propertyIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      continue;
    }

    const indent = leadingSpaces(line);
    if (indent <= propertyIndent) {
      break;
    }

    if (line.trim() === "enum:") {
      enumIndex = i;
      break;
    }
  }

  if (enumIndex === -1) {
    return [];
  }

  const enumIndent = leadingSpaces(lines[enumIndex]);
  const values = [];

  for (let i = enumIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      continue;
    }

    const indent = leadingSpaces(line);
    if (indent <= enumIndent) {
      break;
    }

    if (line.trim().startsWith("- ")) {
      values.push(cleanItem(line));
    }
  }

  return values;
}

function extractMappingKeysUnderKey(block, keyName) {
  const lines = block.split(/\r?\n/);
  const keyIndex = lines.findIndex((line) => line.trim() === `${keyName}:`);
  if (keyIndex === -1) {
    return [];
  }

  const keyIndent = leadingSpaces(lines[keyIndex]);
  const keys = [];

  for (let i = keyIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }

    const indent = leadingSpaces(line);
    if (indent <= keyIndent) {
      break;
    }

    if (indent !== keyIndent + 2) {
      continue;
    }

    const match = /^['\"]?([A-Za-z0-9_.-]+)['\"]?:\s*$/.exec(trimmed);
    if (match && match[1]) {
      keys.push(match[1]);
    }
  }

  return keys;
}

function sameSet(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) {
    return false;
  }

  for (const value of leftSet) {
    if (!rightSet.has(value)) {
      return false;
    }
  }

  return true;
}

function ensureFile(filePath, errors) {
  const absolutePath = path.join(ROOT, filePath);
  if (!fs.existsSync(absolutePath)) {
    errors.push(`Missing required contract file: ${filePath}`);
  }
}

function readFile(filePath, errors) {
  const absolutePath = path.join(ROOT, filePath);
  try {
    return fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    errors.push(`Unable to read ${filePath}: ${error.message}`);
    return "";
  }
}

function assertRequiredFields(block, blockLabel, requiredFields, errors) {
  const required = extractListItemsUnderKey(block, "required");
  for (const field of requiredFields) {
    if (!required.includes(field)) {
      errors.push(`${blockLabel} is missing required field: ${field}`);
    }
  }
}

function assertAdditionalPropertiesFalse(block, blockLabel, errors) {
  if (!/\n\s+additionalProperties:\s*false\s*$/m.test(block)) {
    errors.push(`${blockLabel} must set additionalProperties: false.`);
  }
}

function assertExactPropertyKeys(block, blockLabel, expectedKeys, errors) {
  const found = extractMappingKeysUnderKey(block, "properties");
  if (!sameSet(found, expectedKeys)) {
    errors.push(
      `${blockLabel} property drift. Expected exactly: ${expectedKeys.join(", ")}. Found: ${
        found.join(", ") || "<none>"
      }.`
    );
  }
}

function checkGatewayApi(gatewayApi, errors) {
  const chatPath = extractPathBlock(gatewayApi, "/chat");
  const existingPath = extractPathBlock(gatewayApi, "/conversations/{conversation_id}/messages");
  const listPath = extractPathBlock(gatewayApi, "/conversations");
  const detailPath = extractPathBlock(gatewayApi, "/conversations/{conversation_id}");

  if (!chatPath) {
    errors.push("Gateway API must define /chat endpoint.");
  }
  if (!existingPath) {
    errors.push("Gateway API must define /conversations/{conversation_id}/messages endpoint.");
  }
  if (!listPath) {
    errors.push("Gateway API must define /conversations endpoint.");
  }
  if (!detailPath) {
    errors.push("Gateway API must define /conversations/{conversation_id} endpoint.");
  }

  if (chatPath && !/\n\s+post:\s*$/m.test(chatPath)) {
    errors.push("Gateway /chat endpoint must be POST.");
  }
  if (existingPath && !/\n\s+post:\s*$/m.test(existingPath)) {
    errors.push("Gateway /conversations/{conversation_id}/messages endpoint must be POST.");
  }

  if (chatPath && !/X-Conversation-ID:\s*$/m.test(chatPath)) {
    errors.push("Gateway /chat response must expose X-Conversation-ID header.");
  }
  if (existingPath && !/X-Conversation-ID:\s*$/m.test(existingPath)) {
    errors.push("Gateway /conversations/{conversation_id}/messages response must expose X-Conversation-ID header.");
  }

  const requestSchema = extractSchemaBlock(gatewayApi, "PublicGatewayMessageRequest");
  if (!requestSchema) {
    errors.push("Gateway API must define PublicGatewayMessageRequest schema.");
  } else {
    assertRequiredFields(requestSchema, "PublicGatewayMessageRequest", ["content", "metadata"], errors);
    assertExactPropertyKeys(requestSchema, "PublicGatewayMessageRequest", ["content", "metadata"], errors);
    assertAdditionalPropertiesFalse(requestSchema, "PublicGatewayMessageRequest", errors);

    if (/\n\s+messages:\s*$/m.test(requestSchema)) {
      errors.push(
        "PublicGatewayMessageRequest must not accept client-provided messages arrays; use content plus metadata only."
      );
    }
  }

  const completionSchema = extractSchemaBlock(gatewayApi, "CompletionPayload");
  if (!completionSchema) {
    errors.push("Gateway API must define CompletionPayload schema.");
  } else {
    assertRequiredFields(completionSchema, "CompletionPayload", ["conversation_id", "message_id"], errors);
    assertExactPropertyKeys(completionSchema, "CompletionPayload", ["conversation_id", "message_id"], errors);
    assertAdditionalPropertiesFalse(completionSchema, "CompletionPayload", errors);
  }

  const gatewayEventSchema = extractSchemaBlock(gatewayApi, "GatewayStreamEvent");
  if (!gatewayEventSchema) {
    errors.push("Gateway API must define GatewayStreamEvent schema.");
  } else {
    const eventEnum = extractPropertyEnum(gatewayEventSchema, "event");
    if (!sameSet(eventEnum, REQUIRED_GATEWAY_STREAM_EVENTS)) {
      errors.push(
        `GatewayStreamEvent event enum drift. Expected exactly: ${REQUIRED_GATEWAY_STREAM_EVENTS.join(
          ", "
        )}. Found: ${eventEnum.join(", ") || "<none>"}.`
      );
    }
    assertAdditionalPropertiesFalse(gatewayEventSchema, "GatewayStreamEvent", errors);
  }
}

function checkGatewayEngine(engineApi, errors) {
  const enginePath = extractPathBlock(engineApi, "/engine/chat");
  if (!enginePath) {
    errors.push("Gateway Engine contract must define /engine/chat endpoint.");
  } else if (!/\n\s+post:\s*$/m.test(enginePath)) {
    errors.push("Gateway Engine endpoint /engine/chat must be POST.");
  }

  const engineRequest = extractSchemaBlock(engineApi, "EngineChatRequest");
  if (!engineRequest) {
    errors.push("Gateway Engine contract must define EngineChatRequest schema.");
  } else {
    assertRequiredFields(engineRequest, "EngineChatRequest", ["messages", "metadata"], errors);
    assertExactPropertyKeys(engineRequest, "EngineChatRequest", ["messages", "metadata"], errors);
    assertAdditionalPropertiesFalse(engineRequest, "EngineChatRequest", errors);
  }

  const engineMetadata = extractSchemaBlock(engineApi, "EngineRequestMetadata");
  if (!engineMetadata) {
    errors.push("Gateway Engine contract must define EngineRequestMetadata schema.");
  } else {
    assertRequiredFields(engineMetadata, "EngineRequestMetadata", ["correlation_id"], errors);
    assertExactPropertyKeys(
      engineMetadata,
      "EngineRequestMetadata",
      ["correlation_id", "conversation_id", "trigger", "client_context"],
      errors
    );
    assertAdditionalPropertiesFalse(engineMetadata, "EngineRequestMetadata", errors);

    for (const forbiddenKey of ["provider", "provider_adapter", "model", "tools", "tool_sources"]) {
      if (new RegExp(`\\n\\s+${forbiddenKey}:\\s*$`, "m").test(engineMetadata)) {
        errors.push(`EngineRequestMetadata must not allow runtime reconfiguration key: ${forbiddenKey}`);
      }
    }
  }

  const eventSchema = extractSchemaBlock(engineApi, "EngineStreamEvent");
  if (!eventSchema) {
    errors.push("Gateway Engine contract must define EngineStreamEvent schema.");
  } else {
    const enumValues = extractPropertyEnum(eventSchema, "event");
    if (!sameSet(enumValues, REQUIRED_ENGINE_EVENTS)) {
      errors.push(
        `EngineStreamEvent event enum drift. Expected exactly: ${REQUIRED_ENGINE_EVENTS.join(
          ", "
        )}. Found: ${enumValues.join(", ") || "<none>"}.`
      );
    }
    assertAdditionalPropertiesFalse(eventSchema, "EngineStreamEvent", errors);
  }
}

function checkModelApi(modelApi, errors) {
  const modelPath = extractPathBlock(modelApi, "/model/chat/completions");
  if (!modelPath) {
    errors.push("Model API must define /model/chat/completions endpoint.");
  } else if (!/\n\s+post:\s*$/m.test(modelPath)) {
    errors.push("Model API endpoint /model/chat/completions must be POST.");
  }

  const modelRequest = extractSchemaBlock(modelApi, "ModelChatRequest");
  if (!modelRequest) {
    errors.push("Model API must define ModelChatRequest schema.");
  } else {
    assertRequiredFields(modelRequest, "ModelChatRequest", ["messages", "tools", "stream"], errors);
    assertExactPropertyKeys(modelRequest, "ModelChatRequest", ["messages", "tools", "stream"], errors);
    assertAdditionalPropertiesFalse(modelRequest, "ModelChatRequest", errors);

    if (!/\n\s+stream:\s*$[\s\S]*?\n\s+const:\s*true\s*$/m.test(modelRequest)) {
      errors.push("ModelChatRequest.stream must be const true for streaming-only adapter behavior.");
    }
  }

  const messageSchema = extractSchemaBlock(modelApi, "Message");
  if (!messageSchema) {
    errors.push("Model API must define Message schema.");
  } else {
    assertRequiredFields(messageSchema, "Message", ["role", "content"], errors);
    assertExactPropertyKeys(messageSchema, "Message", ["role", "content", "tool_calls", "tool_call_id"], errors);
    assertAdditionalPropertiesFalse(messageSchema, "Message", errors);
  }

  const messageRole = extractSchemaBlock(modelApi, "MessageRole");
  if (!messageRole) {
    errors.push("Model API must define MessageRole schema.");
  } else {
    const enumValues = extractListItemsUnderKey(messageRole, "enum");
    if (!sameSet(enumValues, REQUIRED_MESSAGE_ROLES)) {
      errors.push(
        `Model API MessageRole enum drift. Expected exactly: ${REQUIRED_MESSAGE_ROLES.join(", ")}. Found: ${
          enumValues.join(", ") || "<none>"
        }.`
      );
    }
  }
}

function checkMessageSchema(messageSchemaSource, errors) {
  let parsed;
  try {
    parsed = JSON.parse(messageSchemaSource);
  } catch (error) {
    errors.push(`message.json must be valid JSON: ${error.message}`);
    return;
  }

  if (parsed?.type !== "object") {
    errors.push("message.json root type must be object.");
  }

  const allowedProperties = ["role", "content", "tool_calls", "tool_call_id"];
  const propertyKeys = parsed?.properties ? Object.keys(parsed.properties) : [];
  if (!sameSet(propertyKeys, allowedProperties)) {
    errors.push(
      `message.json property drift. Expected exactly: ${allowedProperties.join(", ")}. Found: ${
        propertyKeys.join(", ") || "<none>"
      }.`
    );
  }

  if (parsed?.additionalProperties !== false) {
    errors.push("message.json must set additionalProperties to false.");
  }

  const roleEnum = parsed?.properties?.role?.enum;
  if (!Array.isArray(roleEnum) || !sameSet(roleEnum, REQUIRED_MESSAGE_ROLES)) {
    errors.push(
      `message.json role enum drift. Expected exactly: ${REQUIRED_MESSAGE_ROLES.join(", ")}. Found: ${
        Array.isArray(roleEnum) ? roleEnum.join(", ") : "<none>"
      }.`
    );
  }

  const required = Array.isArray(parsed?.required) ? parsed.required : [];
  for (const field of ["role", "content"]) {
    if (!required.includes(field)) {
      errors.push(`message.json is missing required field: ${field}`);
    }
  }

  const allOf = Array.isArray(parsed?.allOf) ? parsed.allOf : [];
  const toolConstraint = allOf.find((entry) => {
    const roleConst = entry?.if?.properties?.role?.const;
    const thenRequired = entry?.then?.required;
    return roleConst === "tool" && Array.isArray(thenRequired) && thenRequired.includes("tool_call_id");
  });

  if (!toolConstraint) {
    errors.push("message.json must require tool_call_id when role is tool.");
  }

  const toolCallDef = parsed?.$defs?.toolCall;
  if (!toolCallDef || toolCallDef.type !== "object" || toolCallDef.additionalProperties !== false) {
    errors.push("message.json must define $defs.toolCall as a strict object schema.");
  }
}

function runContractCheck() {
  const errors = [];

  for (const filePath of REQUIRED_FILES) {
    ensureFile(filePath, errors);
  }

  if (errors.length > 0) {
    return errors;
  }

  const gatewayApi = readFile("specs/openapi/gateway-api.yaml", errors);
  const engineApi = readFile("specs/openapi/gateway-engine.yaml", errors);
  const modelApi = readFile("specs/openapi/model-api.yaml", errors);
  const messageSchema = readFile("specs/schemas/message.json", errors);

  if (errors.length > 0) {
    return errors;
  }

  checkGatewayApi(gatewayApi, errors);
  checkGatewayEngine(engineApi, errors);
  checkModelApi(modelApi, errors);
  checkMessageSchema(messageSchema, errors);

  if (errors.length > 0) {
    return errors;
  }
  return errors;
}

function reportFailure(errors) {
  console.error("Contract check failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
}

function main() {
  const errors = runContractCheck();
  if (errors.length > 0) {
    reportFailure(errors);
    return 1;
  }

  console.log("Contract check passed.");
  return 0;
}

if (require.main === module) {
  const exitCode = main();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

module.exports = {
  runContractCheck
};
