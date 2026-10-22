// @ts-nocheck

const fs = require("node:fs");
const path = require("node:path");
const { runPaaPinCheck } = require("./check-paa-pin.ts");

const ROOT = process.cwd();

function readFile(relativePath, errors) {
  const absolutePath = path.join(ROOT, relativePath);
  try {
    return fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    errors.push(`Unable to read ${relativePath}: ${error.message}`);
    return "";
  }
}

function requireText(source, pattern, label, errors) {
  if (!pattern.test(source)) {
    errors.push(`${label} is missing or has drifted.`);
  }
}

function requireJson(relativePath, requiredKeys, errors) {
  const source = readFile(relativePath, errors);
  if (!source) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    errors.push(`${relativePath} must be valid JSON: ${error.message}`);
    return;
  }

  if (parsed?.type !== "object") {
    errors.push(`${relativePath} must define an object schema.`);
  }

  const required = Array.isArray(parsed?.required) ? parsed.required : [];
  for (const key of requiredKeys) {
    if (!required.includes(key)) {
      errors.push(`${relativePath} is missing required field: ${key}.`);
    }
  }
}

function checkGatewayApi(source, errors) {
  for (const pathName of [
    "/conversations/messages",
    "/conversations",
    "/conversations/{id}",
    "/conversations/{id}/messages"
  ]) {
    requireText(source, new RegExp(`^  ${pathName.replace(/[{}]/g, "\\$&")}:`, "m"), `Gateway API path ${pathName}`, errors);
  }

  if (/^  \/chat:/m.test(source) || /conversation_id\}/.test(source)) {
    errors.push("Gateway API must use the pinned PAA route names, not template-local route aliases.");
  }
  requireText(source, /^    SendMessageRequest:\s*$/m, "Gateway SendMessageRequest schema", errors);
  requireText(source, /^    ConversationList:\s*$/m, "Gateway ConversationList schema", errors);
  requireText(source, /^    Conversation:\s*$/m, "Gateway Conversation schema", errors);
  requireText(source, /^    ClientSSEStream:\s*$/m, "Gateway ClientSSEStream schema", errors);
}

function checkGatewayAgentLoop(source, errors) {
  requireText(source, /^  \/agent-loop\/chat:\s*$/m, "Gateway ↔ Agent Loop path /agent-loop/chat", errors);
  requireText(source, /^    AgentLoopRequest:\s*$/m, "AgentLoopRequest schema", errors);
  requireText(source, /^    RequestMetadata:\s*$/m, "RequestMetadata schema", errors);
  requireText(source, /^    SSEStream:\s*$/m, "SSEStream schema", errors);
  requireText(source, /auth_context:/, "Authenticated actor context", errors);
}

function checkModelApi(source, errors) {
  requireText(source, /^  \/completions:\s*$/m, "Model API path /completions", errors);
  requireText(source, /^    CompletionRequest:\s*$/m, "CompletionRequest schema", errors);
  requireText(source, /^    CompletionStream:\s*$/m, "CompletionStream schema", errors);
  if (/^  \/model\/chat\/completions:/m.test(source)) {
    errors.push("Model API must not promote provider-native /chat/completions into the PAA contract.");
  }
}

function runContractCheck() {
  const errors = [...runPaaPinCheck()];
  if (errors.length > 0) {
    return errors;
  }

  const gatewayApi = readFile("contracts/openapi/gateway-api.yaml", errors);
  const gatewayAgentLoop = readFile("contracts/openapi/gateway-engine.yaml", errors);
  const modelApi = readFile("contracts/openapi/model-api.yaml", errors);

  checkGatewayApi(gatewayApi, errors);
  checkGatewayAgentLoop(gatewayAgentLoop, errors);
  checkModelApi(modelApi, errors);
  requireJson("contracts/schemas/configuration.json", ["memory_root", "provider_adapter", "auth_mode", "tool_sources"], errors);
  requireJson("contracts/schemas/identity.json", ["id", "type", "display_name", "status", "created"], errors);
  requireJson("contracts/schemas/message.json", ["role", "content"], errors);
  requireJson("contracts/schemas/policy.json", ["subject", "resource", "action", "effect"], errors);
  requireJson("contracts/schemas/tool-definition.json", ["name", "description", "parameters", "source", "visibility"], errors);
  requireJson("contracts/schemas/auth-context.json", ["actor", "authentication_id", "authenticated_at", "correlation_id"], errors);
  requireJson("contracts/schemas/authentication-result.json", ["authenticated", "reason", "correlation_id"], errors);
  requireJson("contracts/schemas/authorization-request.json", ["actor_id", "resource", "action", "correlation_id"], errors);
  requireJson("contracts/schemas/authorization-result.json", ["allowed", "reason", "audit_id", "correlation_id"], errors);
  requireJson("contracts/schemas/approval-request.json", ["request_id", "tool_name", "summary", "status", "created_at", "expires_at"], errors);
  requireJson("contracts/schemas/approval-decision.json", ["request_id", "decision", "decided_at"], errors);
  requireJson("contracts/schemas/audit-record.json", ["id", "occurred_at", "event", "actor_id", "action", "result", "correlation_id"], errors);

  return errors;
}

function main() {
  const errors = runContractCheck();
  if (errors.length > 0) {
    console.error("Contract check failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }
  console.log("PAA contract check passed.");
}

if (require.main === module) {
  main();
}

module.exports = { runContractCheck };
