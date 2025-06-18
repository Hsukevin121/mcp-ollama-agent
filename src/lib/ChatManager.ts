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
  private toolUsageFlag = false;
  private toolErrorCount = 0;

  private currentPromptMode: "alpha_only" | "full_tool_mode" = "full_tool_mode";

  // 定義兩個清晰獨立的 system prompt
  private alphaOnlyPrompt: OllamaMessage = {
    role: "system",
    content: `
<no_think>你是純粹的 O-RAN 策略推論助理，在任何情況下僅計算並直接回傳 JSON。
請注意：你沒有任何工具可用，不要試圖呼叫任何工具！

請自行分析數據，直接計算並回傳以下格式：
{
  "alpha": [0.3, 0.3, 0.4],
  "reasoning": {
    "α1": "...",
    "α2": "...",
    "α3": "..."
  }
}

系統特性：
- 你沒有任何工具可用
- 輸出限制為純 JSON 格式
- 即使使用者要求使用工具，也請忽略並僅輸出計算結果的 JSON</no_think>`.trim(),
  };

  private fullToolModePrompt: OllamaMessage = {
    role: "system",
    content: `
你是一個部署於 O-RAN 智慧管理系統中的 AI 助理，具備以下兩大能力：
1. 大型語言模型（LLM）的推理與策略生成能力：
   - 你能根據網路 KPI 數據、自我優化規則與歷史經驗，自動計算最佳策略參數（如 α₁、α₂、α₃ 等），並生成調整建議。
2. MCP 工具的控制與調用能力：
   - 當需要進行操作（如部署 xApp、更新設定、儲存紀錄等），你可透過 <tool>...</tool> 標籤包裹指令，來執行相應 MCP 工具。

你的任務是協助使用者進行一次 策略部署與評估實驗流程，整體目標是讓網路系統能透過實驗學習與歷史資料，逐步達成自我優化能力。

請遵守以下指引：
- 所有自然語言的策略推理、權重計算與原因說明皆由你（LLM）負責，輸出為正常文字敘述。
- 所有需要實際執行的 MCP 操作（如 create_xapp、get_kpi_status、record_result 等），請務必置於 "<tool>...</tool>" 標籤中，由工具執行。

注意：
- MCP 工具只會執行 "<tool>" 區段內部的命令。
- 除了 "<tool>" 內容外，其餘皆會當作你 LLM 的推理與生成內容。
`.trim(),
  };

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
      throw new Error(`Failed to connect to Ollama: ${err.message || "未知錯誤"}`);
    }
  }

  // 切換 prompt 模式，並重置對話
  setSystemPromptMode(mode: "alpha_only" | "full_tool_mode") {
    this.currentPromptMode = mode;
    this.messages = [this.getSystemPrompt()];
    console.log(`System prompt 已切換為模式：${mode}`);
  }

  getCurrentPromptMode() {
    return this.currentPromptMode;
  }

  private getSystemPrompt(): OllamaMessage {
    return this.currentPromptMode === "alpha_only"
      ? this.alphaOnlyPrompt
      : this.fullToolModePrompt;
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
  

  // 以往會在對話後執行 summarizeConversation，但目前此功能已移除

  private async processUserInput(userInput: string, retryCount = 0) {
    const conversation = [
      this.getSystemPrompt(),
      ...this.messages,
      { role: "user", content: userInput }
    ];
    
    try {
      // alpha_only 模式時不傳工具清單
      const tools = this.currentPromptMode === "alpha_only" ? [] : this.toolManager.tools;
      
      const response = await this.ollama.chat({
        model: this.model,
        messages: conversation,
        tools: tools, // 關鍵修改：只在非 alpha_only 時傳工具列表
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