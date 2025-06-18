// 擴充後的 src/server.ts：保留原有 ChatManager 架構，新增工具、模型切換 API
import express from "express";
import bodyParser from "body-parser";
import { ChatManager } from "./ChatManager";
import { ollamaConfig } from "../config";
import cors from "cors";
import fs from "fs-extra";
import path from "path";

const app = express();
app.use(cors());
app.use(bodyParser.json());    // 確保能解析 JSON body
const PORT = 3100;

// 支援 JSON 請求
app.use(bodyParser.json());

const chatManager = new ChatManager(ollamaConfig);
let currentModel = ollamaConfig.model || 'default';

chatManager.initialize().then(() => {
  console.log("ChatManager initialized and ready.");
}).catch((err) => {
  console.error("Failed to initialize ChatManager:", err);
  process.exit(1);
});

// 對話 API：接收前端輸入並取得回覆
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "缺少 message 欄位，或格式錯誤" });
  }

  try {
    const result = await chatManager.handleUserInput(message);
    res.json({
      reply: result.reply,
      toolResults: result.toolResults || []
    });
  } catch (err) {
    res.status(500).json({ error: "AI 回覆失敗", detail: err instanceof Error ? err.message : String(err) });
  }
});

// 工具 API
app.get("/api/tools", async (_, res) => {
  try {
    const tools = chatManager.toolManager?.tools || [];
    res.json({ tools });
  } catch (err) {
    console.error("取得工具清單錯誤：", err);
    res.status(500).json({ error: "無法取得工具清單" });
  }
});

// 模型清單 API
app.get("/api/models", async (_, res) => {
  try {
    const response = await fetch(`${ollamaConfig.host}/api/tags`);
    const data = await response.json();
    const models = data.models.map((m: any) => m.name);
    res.json({ models, currentModel });
  } catch (err) {
    console.error("取得模型清單失敗：", err);
    res.status(500).json({ error: "無法取得模型清單" });
  }
});

// 重置對話 API
app.post("/api/chat/new", async (_, res) => {
  try {
    chatManager.reset(); //  清空上下文
    res.json({ message: "上下文已清除" });
  } catch (err) {
    console.error("重置對話錯誤：", err);
    res.status(500).json({ error: "重置對話失敗" });
  }
});

// LangChain API 訓練用
import { XappTrainer } from "./XappTrainer";
const trainer = new XappTrainer(chatManager);
app.post("/api/train", async (_, res) => {
  try {
    await trainer.trainXappFlow();
    res.json({ message: "訓練流程完成" });
  } catch (err) {
    console.error("訓練流程失敗：", err);
    res.status(500).json({ error: "訓練失敗" });
  }
});

// 切換 system prompt 模式
app.post("/api/chat/mode", (req, res) => {
  const { mode } = req.body as { mode?: string };
  if (mode !== "alpha_only" && mode !== "full_tool_mode") {
    return res
      .status(400)
      .json({ error: "mode 欄位錯誤，只能是 alpha_only 或 full_tool_mode" });
  }

  try {
    chatManager.setSystemPromptMode(mode);
    res.json({ message: "System prompt 已切換", mode });
  } catch (err) {
    console.error("切換 system prompt 失敗：", err);
    res.status(500).json({ error: "切換 system prompt 失敗" });
  }
});

// 啟動伺服器
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Chat API server is running at http://0.0.0.0:${PORT}`);
});
