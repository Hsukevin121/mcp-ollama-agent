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
      console.log("Ollama 連線成功");
    } catch (error) {
      const err = error as ErrorWithCause;
      const errorMsg = err.message || "未知錯誤";
      console.error(`Ollama 初始化失敗: ${errorMsg}`);
      throw new Error(`Failed to connect to Ollama: ${errorMsg}`);
    }
  }

  private getSystemPrompt(): OllamaMessage {
    return {
      role: "system",
      content: `你是一個 O-RAN 智慧系統中的 AI 助理，具備以下三種能力：
- LLM 的推理與生成能力
- MCP 工具的操作能力
- 向量資料庫記憶（RAG）的查詢能力

你的任務是進行一次策略部署實驗，並透過工具與資料觀察效能變化，以學習如何讓網路具備自我優化能力。
`.trim()
};
  }

  reset() {
    console.log("Resetting conversation state...");
  
    // 確保所有對話狀態清空
    this.messages.length = 0;
    this.toolUsageFlag = false;
    this.toolErrorCount = 0;
  
    console.log("對話已重置為新狀態");
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
    console.log(`已記錄策略結果（成功: ${success}, 工具使用: ${this.toolUsageFlag}, 工具錯誤次數: ${this.toolErrorCount}）`);
  }


  

  async handleUserInput(userInput: string): Promise<{
    reply: string;
    toolResults: { toolName: string; result: string }[];
    triggeredTools: string[];  // ✅ 加上這一欄
  }> {
    this.toolUsageFlag = false;
    this.toolErrorCount = 0;
  
    const prevToolCount = this.messages.filter(m => m.role === "tool").length;
  
    await this.processUserInput(userInput);
  
    const newTools = this.messages.filter(m => m.role === "tool").slice(prevToolCount);
    const lastMsg = this.messages[this.messages.length - 1];
  
    const toolResults = newTools.map(m => ({
      toolName: this.extractToolName(m.content),
      result: m.content || ""
    }));
  
    const triggeredTools = toolResults.map(t => t.toolName);  // ✅ 建立 triggered 工具清單
  
    return {
      reply: lastMsg?.content || "(No response)",
      toolResults,
      triggeredTools
    };
  }
  
  
  
  private extractToolName(content: string): string {
    try {
      const match = content.match(/Tool\s+"(.+?)"\s+回傳結果/);
      return match?.[1] ?? "unknown";
    } catch {
      return "unknown";
    }
  }
  

  // 刪除 compressHistory，改為 summarizeConversation
  private async summarizeConversation() {
    // 取最近 6 則對話（可依需求調整）
    const recentMessages = this.messages.slice(-6);
    const summaryPrompt: OllamaMessage = {
      role: "user",
      content: "請用一句話摘要剛才這輪對話的重點（簡短即可）。"
    };
    const summaryRes = await this.ollama.chat({
      model: this.model,
      messages: [
        this.getSystemPrompt(),
        ...recentMessages,
        summaryPrompt
      ],
      tools: [],
    });
    const summary = summaryRes.message.content;
    console.log("本輪摘要:", summary);
    await this.recordResult(summary, true);
    return summary;
  }

  private async processUserInput(userInput: string, retryCount = 0) {
    const conversation = [
      this.getSystemPrompt(),
      ...this.messages,
      { role: "user", content: userInput }
    ];
    

    try {
      const recallRes = await axios.post(`${RAG_API_BASE}/recall_sample_vector`, { text: userInput });
      const relatedDocs = (recallRes.data.matches || []).filter((doc: any) => doc.certainty >= 0.75);

      if (relatedDocs.length > 0) {
        const contextText = relatedDocs
          .map((doc, i) => `[${i + 1}] 來源: ${doc.source_doc || "未知"}，時間: ${doc.created_at || "未知"}\n${doc.text}`)
          .join("\n\n");
        console.log("📚 [RAG] 以下是檢索到的相關知識：");
        relatedDocs.forEach((doc, i) => {
          console.log(`🔹 [${i + 1}] (certainty: ${doc.certainty})`);
          console.log(`    來源: ${doc.source_doc}`);
          console.log(`    時間: ${doc.created_at}`);
          console.log(`    內容:\n${doc.text}\n`);
        });
        this.messages.push({
          role: "system",
          content: `以下為相關背景資訊，請引用來源 [1]、[2] 等格式回答：\n${contextText}`,
        });
      } else {
        console.log("RAG 無相關結果。");
      }

      const response = await this.ollama.chat({
        model: this.model,
        messages: conversation,
        tools: this.toolManager.tools,
      });

      this.messages.push(response.message);
      const toolCalls = response.message.tool_calls ?? [];

      if (toolCalls.length > 0) {
        console.log(`共收到 ${toolCalls.length} 個工具呼叫`);
        this.toolUsageFlag = true;
        await this.handleToolCalls(toolCalls, retryCount);
      } else {
        console.log("LLM 回覆中未觸發工具。");
        await this.recordResult("LLM 回答未使用工具", false);
        console.log("Assistant:", response.message.content);
      }

      // === 新增：每次對話後做一小段總結 ===
      await this.summarizeConversation();

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
          content: `🔧 Tool "${toolCall.function.name}" 回傳結果:\n${formatted}`,
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
    console.log("Assistant 回覆:", finalResponse.message.content);
    return finalResponse.message;
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