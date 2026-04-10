#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_ROOT = "philnits-vault";
const STOP_LINE_REGEXES = [
  /^%%.*%%$/,
  /^%%$/,
  /^---+$/,
  /^#\s*References\b/i,
];

const parseArgs = (argv) => {
  const args = {
    root: DEFAULT_ROOT,
    limit: Number.POSITIVE_INFINITY,
    overwrite: false,
    dryRun: false,
    match: "",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    concurrency: 1,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--overwrite") {
      args.overwrite = true;
      continue;
    }

    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (token === "--root") {
      args.root = argv[index + 1] ?? args.root;
      index += 1;
      continue;
    }

    if (token === "--limit") {
      const parsed = Number(argv[index + 1]);
      if (!Number.isNaN(parsed) && parsed > 0) {
        args.limit = parsed;
      }
      index += 1;
      continue;
    }

    if (token === "--match") {
      args.match = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (token === "--model") {
      args.model = argv[index + 1] ?? args.model;
      index += 1;
      continue;
    }

    if (token === "--base-url") {
      args.baseUrl = argv[index + 1] ?? args.baseUrl;
      index += 1;
      continue;
    }

    if (token === "--concurrency") {
      const parsed = Number(argv[index + 1]);
      if (!Number.isNaN(parsed) && parsed > 0) {
        args.concurrency = Math.floor(parsed);
      }
      index += 1;
    }
  }

  return args;
};

const normalizeSpaces = (text) => text.replace(/\s+/g, " ").trim();

const stripInlineMarkdown = (text) =>
  text
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`/g, "")
    .replace(/\[\[(.*?)\]\]/g, "$1")
    .trim();

const parseOptionPrefix = (line) => {
  const stripped = stripInlineMarkdown(line);
  const match = stripped.match(/^([A-Da-d])[.)]\s*(.+)$/);
  if (!match) {
    return null;
  }

  return {
    key: match[1].toUpperCase(),
    text: normalizeSpaces(match[2]),
  };
};

const parseCorrectOption = (rawAnswerLine) => {
  const cleaned = stripInlineMarkdown(rawAnswerLine).trim();
  if (!cleaned) {
    return null;
  }

  if (/[A-Za-z]\s*[,/]/.test(cleaned)) {
    return null;
  }

  const direct = cleaned.match(/^\(?([A-Da-d])\)?[.)]?\s*/);
  if (direct) {
    return direct[1].toUpperCase();
  }

  if (/^[A-Da-d]$/.test(cleaned)) {
    return cleaned.toUpperCase();
  }

  return null;
};

const shouldStopExplanation = (line) => {
  const trimmed = line.trim();
  return STOP_LINE_REGEXES.some((pattern) => pattern.test(trimmed));
};

const parseQuestion = (rawMarkdown) => {
  const lines = rawMarkdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^#\s+/.test(line.trim()));
  if (headingIndex < 0) {
    return null;
  }

  const delimiterIndex = lines.findIndex((line, index) => index > headingIndex && /^\?\s*$/.test(line.trim()));
  if (delimiterIndex < 0) {
    return null;
  }

  const answerLineIndex = lines.findIndex((line, index) => index > delimiterIndex && line.trim().length > 0);
  if (answerLineIndex < 0) {
    return null;
  }

  const answerLine = lines[answerLineIndex] ?? "";
  const correctOption = parseCorrectOption(answerLine);
  if (!correctOption) {
    return null;
  }

  const bodyLines = lines.slice(headingIndex + 1, delimiterIndex);
  const questionParts = [];
  const options = [];
  let currentOptionIndex = -1;

  for (const rawLine of bodyLines) {
    const line = rawLine.trim();
    if (!line || /^%%.*%%$/.test(line) || line === "%%" || /^!\[\[/.test(line)) {
      continue;
    }

    const parsedOption = parseOptionPrefix(line);
    if (parsedOption) {
      options.push(parsedOption);
      currentOptionIndex = options.length - 1;
      continue;
    }

    if (currentOptionIndex >= 0) {
      const continuedText = normalizeSpaces(stripInlineMarkdown(line));
      if (continuedText) {
        options[currentOptionIndex].text = `${options[currentOptionIndex].text} ${continuedText}`.trim();
      }
      continue;
    }

    const cleanedQuestionLine = normalizeSpaces(stripInlineMarkdown(line));
    if (cleanedQuestionLine) {
      questionParts.push(cleanedQuestionLine);
    }
  }

  const explanationStart = answerLineIndex + 1;
  let explanationEnd = lines.length;
  for (let index = explanationStart; index < lines.length; index += 1) {
    if (shouldStopExplanation(lines[index])) {
      explanationEnd = index;
      break;
    }
  }

  const existingExplanation = lines.slice(explanationStart, explanationEnd).join("\n").trim();
  const questionText = questionParts.join(" ").trim();

  if (!questionText || options.length < 2) {
    return null;
  }

  const optionByKey = new Map(options.map((entry) => [entry.key, entry.text]));

  return {
    lines,
    answerLineIndex,
    explanationStart,
    explanationEnd,
    existingExplanation,
    questionText,
    options,
    correctOption,
    correctOptionText: optionByKey.get(correctOption) ?? "",
  };
};

const buildPrompt = ({ questionText, options, correctOption, correctOptionText }) => {
  const optionText = options.map((option) => `${option.key}. ${option.text}`).join("\n");

  return [
    "You are writing concise FE exam coaching explanations.",
    "Explain why the correct choice is correct and why each incorrect option is incorrect.",
    "Keep it practical and readable for review.",
    "Use markdown bullets and short paragraphs.",
    "Do not mention that you are an AI.",
    "",
    `Question: ${questionText}`,
    "",
    "Choices:",
    optionText,
    "",
    `Correct Answer: ${correctOption}. ${correctOptionText}`,
    "",
    "Output format:",
    "- Start with one short summary line.",
    "- Then a section named 'Why this is correct'.",
    "- Then a section named 'Why the other choices are wrong'.",
  ].join("\n");
};

const callOpenAI = async ({ baseUrl, apiKey, model, prompt }) => {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "You generate accurate exam explanations in markdown.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("OpenAI returned an empty explanation.");
  }

  return content.trim();
};

const walkMarkdownFiles = async (dirPath) => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
};

const updateExplanationBlock = (rawMarkdown, parsed, explanation) => {
  const newline = rawMarkdown.includes("\r\n") ? "\r\n" : "\n";
  const generatedLines = [
    "",
    "### AI Explanation",
    "",
    ...explanation.split(/\r?\n/),
    "",
  ];

  const updated = [
    ...parsed.lines.slice(0, parsed.explanationStart),
    ...generatedLines,
    ...parsed.lines.slice(parsed.explanationEnd),
  ];

  return updated.join(newline);
};

const createWorker = async ({ queue, runOne }) => {
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      return;
    }

    await runOne(next);
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Set it in your shell before running this script.");
  }

  const rootPath = path.resolve(process.cwd(), args.root);
  const rootExists = await fs
    .stat(rootPath)
    .then((stat) => stat.isDirectory())
    .catch(() => false);

  if (!rootExists) {
    throw new Error(`Root path is not a directory: ${rootPath}`);
  }

  const allFiles = (await walkMarkdownFiles(rootPath))
    .sort((first, second) => first.localeCompare(second))
    .filter((filePath) => (args.match ? filePath.includes(args.match) : true));

  const fileQueue = [];
  let skippedHasExplanation = 0;
  let skippedUnparseable = 0;

  for (const filePath of allFiles) {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = parseQuestion(raw);

    if (!parsed) {
      skippedUnparseable += 1;
      continue;
    }

    if (!args.overwrite && parsed.existingExplanation) {
      skippedHasExplanation += 1;
      continue;
    }

    fileQueue.push({ filePath, raw, parsed });

    if (fileQueue.length >= args.limit) {
      break;
    }
  }

  let written = 0;
  let failed = 0;

  const runOne = async ({ filePath, raw, parsed }) => {
    try {
      const prompt = buildPrompt(parsed);
      const explanation = await callOpenAI({
        baseUrl: args.baseUrl,
        apiKey,
        model: args.model,
        prompt,
      });

      const updatedMarkdown = updateExplanationBlock(raw, parsed, explanation);
      const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, "/");

      if (args.dryRun) {
        console.log(`[DRY RUN] Would update ${relativePath}`);
        written += 1;
        return;
      }

      await fs.writeFile(filePath, updatedMarkdown, "utf8");
      console.log(`[UPDATED] ${relativePath}`);
      written += 1;
    } catch (error) {
      const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
      console.error(`[FAILED] ${relativePath} :: ${error.message}`);
      failed += 1;
    }
  };

  const queue = [...fileQueue];
  const workerCount = Math.min(args.concurrency, Math.max(1, queue.length));

  await Promise.all(
    Array.from({ length: workerCount }, () => createWorker({ queue, runOne })),
  );

  console.log("\nSummary");
  console.log(`- Scanned markdown files: ${allFiles.length}`);
  console.log(`- Pending generation: ${fileQueue.length}`);
  console.log(`- Updated: ${written}`);
  console.log(`- Failed: ${failed}`);
  console.log(`- Skipped (already had explanation): ${skippedHasExplanation}`);
  console.log(`- Skipped (unparseable): ${skippedUnparseable}`);
};

main().catch((error) => {
  console.error(`Fatal: ${error.message}`);
  process.exitCode = 1;
});
