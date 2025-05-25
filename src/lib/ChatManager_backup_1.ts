// 強化版 ChatManager.ts（加入工具觸發率、snapshot 對比與錯誤率統計 + reset 支援）
import { ChatInterface } from "./ChatInterface";
import { Ollama } from "ollama";
import { OllamaMessage } from "../utils/types/ollamaTypes";
import { ToolManager } from "./ToolManager";
import { formatToolResponse } from "../utils/toolFormatters";
import axios from "axios";

const RAG_API_BASE = "http://192.168.31.130:8500";

interface ErrorWithCause extends Error {
  cause?: { code?: string };
}

export class ChatManager {
  private ollama: Ollama;
  private messages: OllamaMessage[] = [];
  private toolManager: ToolManager;
  private chatInterface: ChatInterface;
  private model: string;
  private maxRetryCount = 3;
  private toolUsageFlag = false;
  private toolErrorCount = 0;

  constructor(ollamaConfig: { host?: string; model?: string } = {}) {
    this.ollama = new Ollama(ollamaConfig);
    this.model = ollamaConfig.model || "qwen2.5:latest";
    this.toolManager = new ToolManager();
    this.chatInterface = new ChatInterface();

    this.reset();
  }

  async initialize() {
    await this.toolManager.initialize();
    try {
      await this.ollama.chat({
        model: this.model,
        messages: [{ role: "user", content: "test" }],
        tools: [],
      });
      console.log("✅ Ollama 連線成功");
    } catch (error) {
      const err = error as ErrorWithCause;
      const errorMsg = err.message || "未知錯誤";
      console.error(`❌ Ollama 初始化失敗: ${errorMsg}`);
      throw new Error(`Failed to connect to Ollama: ${errorMsg}`);
    }
  }

  reset() {
    this.messages = [
      {
        role: "system",
        content:
          "You are a helpful AI assistant. If you need external data, you MUST use tools (e.g., get_kpi_status, snapshot_save) to retrieve it. Don't make assumptions."
      }
    ];
    console.log("🔁 對話已重置");
  }

  private compressHistory(maxMessages = 10) {
    if (this.messages.length > maxMessages) {
      const recentMessages = this.messages.slice(-maxMessages);
      const summary = this.messages
        .slice(0, -maxMessages)
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");

      this.messages = [
        { role: "system", content: `Summary of previous conversation:\n${summary}` },
        ...recentMessages,
      ];
      console.log("🔁 上下文已摘要壓縮");
    }
  }

  private async recordResult(summary: string, success: boolean, strategy?: Record<string, any>, source_doc?: string) {
    await axios.post(`${RAG_API_BASE}/record_result`, {
      summary,
      type: "xapp_result",
      task_type: "xapp_result",
      strategy: strategy || {},
      strategy_id: `xapp-${Date.now()}`,
      source_doc: source_doc || "unknown",
      user: "Kevin",
      success,
      tool_used: this.toolUsageFlag,
      tool_errors: this.toolErrorCount
    });
    console.log(`📦 已記錄策略結果（成功: ${success}, 工具使用: ${this.toolUsageFlag}, 工具錯誤次數: ${this.toolErrorCount}）`);
  }

  async handleUserInput(userInput: string): Promise<string> {
    this.toolUsageFlag = false;
    this.toolErrorCount = 0;
    await this.processUserInput(userInput);
    const last = this.messages[this.messages.length - 1];
    return last?.content || "(No response)";
  }

  private async processUserInput(userInput: string, retryCount = 0) {
    this.messages.push({ role: "user", content: userInput });

    try {
      const recallRes = await axios.post(`${RAG_API_BASE}/recall`, { text: userInput });
      const relatedDocs = (recallRes.data.selected_docs || []).filter((doc: any) => doc._additional?.certainty >= 0.75);

      if (relatedDocs.length > 0) {
        const contextText = relatedDocs
          .map((doc, i) => `[${i + 1}] 來源: ${doc.source_doc || "未知"}，時間: ${doc.created_at || "未知"}\n${doc.text}`)
          .join("\n\n");

        this.messages.push({
          role: "system",
          content: `以下為相關背景資訊，請引用來源 [1]、[2] 等格式回答：\n${contextText}`,
        });
      } else {
        console.log("❌ RAG 無相關結果。");
      }

      const response = await this.ollama.chat({
        model: this.model,
        messages: this.messages,
        tools: this.toolManager.tools,
      });

      this.messages.push(response.message);
      const toolCalls = response.message.tool_calls ?? [];

      if (toolCalls.length > 0) {
        console.log(`🛠️ 共收到 ${toolCalls.length} 個工具呼叫`);
        this.toolUsageFlag = true;
        await this.handleToolCalls(toolCalls, retryCount);
      } else {
        console.log("⚠️ LLM 回覆中未觸發工具。");
        await this.recordResult("LLM 回答未使用工具", false);
        console.log("Assistant:", response.message.content);
      }

      this.compressHistory();
    } catch (error) {
      this.messages.pop();
      console.error("處理錯誤：", error);
      throw error;
    }
  }

  private async handleToolCalls(toolCalls: any[], retryCount: number) {
    for (const toolCall of toolCalls) {
      const args = this.parseToolArguments(toolCall.function.arguments);
      console.log(`Using tool: ${toolCall.function.name}`);

      const parameterMappings = this.toolManager.suggestParameterMapping(toolCall.function.name, args);
      const fixedArgs = this.fixToolArguments(args, parameterMappings);

      const result = await this.toolManager.callTool(toolCall.function.name, fixedArgs);

      if (result) {
        const resultContent = result.content;
        const formatted = formatToolResponse(resultContent);
        console.log(`\n[${new Date().toISOString()}] 🔧 Tool "${toolCall.function.name}" 回傳結果:`);
        console.log(formatted);

        if (Array.isArray(resultContent) && resultContent[0]?.text?.includes("Error")) {
          this.toolErrorCount++;
        }

        this.messages.push({
          role: "tool",
          content: formatted,
          tool_call_id: toolCall.function.name,
        });
      }
    }

    const finalResponse = await this.ollama.chat({
      model: this.model,
      messages: this.messages,
      tools: this.toolManager.tools,
    });

    this.messages.push(finalResponse.message);
    await this.recordResult(finalResponse.message.content, true);
    console.log("🤖 Assistant 回覆:", finalResponse.message.content);
  }

  private fixToolArguments(args: Record<string, unknown>, mappings: Record<string, string>) {
    const fixedArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      const mappedKey = mappings[key] || key;
      fixedArgs[mappedKey] = value;
    }
    return fixedArgs;
  }

  private parseToolArguments(args: string | Record<string, unknown>) {
    if (typeof args === "string") {
      try {
        return JSON.parse(args);
      } catch (e) {
        console.error("Failed to parse tool arguments:", e);
        return { value: args };
      }
    }
    return args;
  }

  private cleanup() {
    this.chatInterface.close();
    this.toolManager.cleanup();
  }
}
