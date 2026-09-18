import { createOpenAI } from "@ai-sdk/openai";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { z } from "zod";

loadEnvFile();

const apiKey = process.env.ARK_API_KEY;
const modelId = process.env.ARK_MODEL_ID;

if (!apiKey) {
  throw new Error(".env 中没有设置 ARK_API_KEY");
}

if (!modelId) {
  throw new Error(".env 中没有设置 ARK_MODEL_ID");
}

const ark = createOpenAI({
  baseURL: "https://ark.cn-beijing.volces.com/api/v3",
  apiKey,
});

const cwd = resolve(process.argv[2] || process.cwd());

const read = tool({
  description: `读取项目中的指定文件，并返回带行号的内容。适用场景：查看文件内容、检查配置、阅读源代码。不适用场景：列出目录，或者跨多个文件搜索。`,
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("相对于工作目录的文件路径"),
    offset: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("起始行号，从 1 开始"),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("最多返回多少行"),
  }),
  execute: async ({ path: filePath, offset, limit }) => {
    const absolutePath = resolve(cwd, filePath);
    const relativePath = relative(cwd, absolutePath);

    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("不能读取工作目录之外的文件");
    }

    const content = await readFile(absolutePath, "utf8");
    let lines = content.split("\n");
    const startLine = offset ?? 1;

    lines = lines.slice(startLine - 1);

    if (limit !== undefined) {
      lines = lines.slice(0, limit);
    }

    const maxLines = 500;
    const truncated = lines.length > maxLines;

    if (truncated) {
      lines = lines.slice(0, maxLines);
    }

    const numberedLines = lines.map(
      (line, index) => `${startLine + index}: ${line}`,
    );

    if (truncated) {
      numberedLines.push(`……（内容已截断，最多返回 ${maxLines} 行）`);
    }

    return numberedLines.join("\n");
  },
});

const agent = new ToolLoopAgent({
  model: ark.chat(modelId),
  instructions: `你是一个编程智能体。\n当前工作目录：${cwd}`,
  tools: { read },
  stopWhen: stepCountIs(10),
});

const prompt = process.argv.slice(3).join(" ") || "你好！";
const { text, steps } = await agent.generate({ prompt });

console.log(text);
console.log(`\n（共 ${steps.length} 步）`);
