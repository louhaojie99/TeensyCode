import { createOpenAI } from "@ai-sdk/openai";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { spawnSync } from "node:child_process";
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
  description: `读取项目中的一个已知文件，并返回带行号的内容。
适用场景：查看已知路径的文件内容、检查配置、阅读源代码。
不适用场景：不知道内容在哪个文件，或者需要跨多个文件搜索；这些情况应使用 grep。
禁止用途：运行命令、列出目录、搜索多个文件。
示例：读取 package.json；读取 index.ts 第 20 行开始的 10 行。`,
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

const grep = tool({
  description: `使用正则表达式搜索项目中的文件内容，返回文件路径、行号和匹配行。
适用场景：跨文件查找文本、定位函数定义、查找导入语句、待办标记或错误信息。
不适用场景：读取一个路径已知的文件；这种情况应使用 read。
禁止用途：运行任意命令、列出目录、修改文件。
范围规则：搜索会自动递归子目录；glob 为 *.ts 已覆盖各级目录；始终排除 node_modules 和 .git，禁止尝试搜索这两个目录。
停止规则：结果会明确给出总匹配数、返回数和是否截断；得到这些统计后立即回答，禁止使用等价的 glob 或 pattern 重复搜索。
示例：查找所有待办标记，pattern 为 TODO，glob 为 *.ts；查找函数定义，pattern 为 function\\s+\\w+，glob 为 *.ts。`,
  inputSchema: z.object({
    pattern: z.string().min(1).describe("要搜索的正则表达式"),
    path: z
      .string()
      .min(1)
      .optional()
      .describe("要搜索的项目内目录，默认为工作目录"),
    glob: z
      .string()
      .min(1)
      .optional()
      .describe("文件名过滤规则，例如 *.ts"),
  }),
  execute: async ({ pattern, path: searchPath, glob: globFilter }) => {
    const searchDirectory = resolve(cwd, searchPath ?? ".");
    const relativePath = relative(cwd, searchDirectory);

    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("不能搜索工作目录之外的路径");
    }

    const args = [
      "-r",
      "-n",
      "-E",
      "--exclude-dir=node_modules",
      "--exclude-dir=.git",
    ];

    if (globFilter) {
      args.push(`--include=${globFilter}`);
    }

    args.push("--", pattern, searchDirectory);

    const result = spawnSync("grep", args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });

    if (result.error) {
      throw new Error(`搜索执行失败：${result.error.message}`);
    }

    if (result.status !== 0 && result.status !== 1) {
      const message = result.stderr.trim() || `退出状态为 ${result.status}`;
      throw new Error(`搜索执行失败：${message}`);
    }

    const lines = result.stdout.trim().split("\n").filter(Boolean);

    if (lines.length === 0) {
      return {
        summary: "总匹配数为 0；没有返回结果；未截断。",
        totalMatches: 0,
        returnedMatches: 0,
        truncated: false,
        matches: [],
      };
    }

    const maxMatches = 50;
    const matches = lines.slice(0, maxMatches);
    const truncated = lines.length > maxMatches;

    return {
      summary: truncated
        ? `总匹配数为 ${lines.length}；返回前 ${matches.length} 条；已截断。`
        : `总匹配数为 ${lines.length}；返回 ${matches.length} 条；未截断。`,
      totalMatches: lines.length,
      returnedMatches: matches.length,
      truncated,
      matches,
    };
  },
});

const agent = new ToolLoopAgent({
  model: ark.chat(modelId),
  instructions: `你是一个编程智能体。\n当前工作目录：${cwd}`,
  tools: { read, grep },
  stopWhen: stepCountIs(10),
});

const prompt = process.argv.slice(3).join(" ") || "你好！";
const { text, steps } = await agent.generate({ prompt });

console.log(text);

const toolTrace = steps.flatMap((step) =>
  step.toolCalls.map((toolCall) => ({
    step: step.stepNumber + 1,
    name: toolCall.toolName,
    input: toolCall.input,
  })),
);

const grepResultTrace = steps.flatMap((step) =>
  step.toolResults.flatMap((toolResult) => {
    const output = toolResult.output;

    if (
      toolResult.toolName !== "grep" ||
      typeof output !== "object" ||
      output === null ||
      !("summary" in output) ||
      typeof output.summary !== "string"
    ) {
      return [];
    }

    return [{ step: step.stepNumber + 1, summary: output.summary }];
  }),
);

console.log("\n工具调用轨迹：");

if (toolTrace.length === 0) {
  console.log("- 没有调用工具");
} else {
  for (const toolCall of toolTrace) {
    console.log(
      `- 第 ${toolCall.step} 步：调用 ${toolCall.name}，参数 ${JSON.stringify(toolCall.input)}`,
    );
  }
}

if (grepResultTrace.length > 0) {
  console.log("\n搜索结果统计：");

  for (const result of grepResultTrace) {
    console.log(`- 第 ${result.step} 步：${result.summary}`);
  }
}

console.log(`\n（共 ${steps.length} 步）`);
