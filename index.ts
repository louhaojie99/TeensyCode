import { createOpenAI } from "@ai-sdk/openai";
import { ToolLoopAgent, stepCountIs } from "ai";
import { loadEnvFile } from "node:process";

loadEnvFile();

const apiKey = process.env.ARK_API_KEY;
const modelId = process.env.ARK_MODEL_ID;

if (!apiKey) {
  throw new Error("ARK_API_KEY is not set in .env");
}

if (!modelId) {
  throw new Error("ARK_MODEL_ID is not set in .env");
}

const ark = createOpenAI({
  baseURL: "https://ark.cn-beijing.volces.com/api/v3",
  apiKey,
});

const cwd = process.argv[2] || process.cwd();

const agent = new ToolLoopAgent({
  model: ark.chat(modelId),
  instructions: `You are a coding agent.\nWorking directory: ${cwd}`,
  tools: {},
  stopWhen: stepCountIs(10),
});

const prompt = process.argv.slice(3).join(" ") || "Hello!";
const { text, steps } = await agent.generate({ prompt });

console.log(text);
console.log(`\n(${steps.length} steps)`);
