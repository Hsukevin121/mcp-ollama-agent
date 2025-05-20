import { ChatInterface } from "./ChatInterface";
import { Ollama } from "ollama";
import { OllamaMessage } from "../utils/types/ollamaTypes";
import { ToolManager } from "./ToolManager";
import { formatToolResponse } from "../utils/toolFormatters";
import axios from "axios";

const RAG_API_BASE = "http://192.168.31.132:8500";

interface ErrorWithCause extends Error {
  cause?: {
    code?: string;
  };
}

export class ChatManager {
  private ollama: Ollama;
  private messages: OllamaMessage[] = [];
  private toolManager: ToolManager;
  private chatInterface: ChatInterface;
  private model: string;

  constructor(ollamaConfig: { host?: string; model?: string } = {}) {
    this.ollama = new Ollama(ollamaConfig);
    this.model = ollamaConfig.model || "qwen2.5:latest"; // Default fallback if not provided
    this.toolManager = new ToolManager();
    this.chatInterface = new ChatInterface();

    this.messages = [
      {
        role: "system",
        content:
          "You are a helpful AI assistant. Please provide clear, accurate, and relevant responses to user queries. If you need to use tools to help answer a question, explain what you're doing.",
      },
    ];
  }

  reset() {
    this.messages = []; // 清除所有上下文
    console.log("🔁 上下文已重置");
  }

  async initialize() {
    await this.toolManager.initialize();
    // Test Ollama connection
    try {
      await this.testOllamaConnection();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to connect to Ollama. Is Ollama running? Error: ${errorMsg}`
      );
    }
  }

  private async testOllamaConnection() {
    try {
      // Try a simple chat call to test connection
      await this.ollama.chat({
        model: this.model,
        messages: [{ role: "user", content: "test" }],
        tools: [],
      });
    } catch (error) {
      const err = error as ErrorWithCause;
      if (err.cause?.code === "ECONNREFUSED") {
        throw new Error("Could not connect to Ollama server");
      }
      throw error;
    }
  }

  async start() {
    try {
      console.log('Chat started. Type "exit" to end the conversation.');

      while (true) {
        const userInput = await this.chatInterface.getUserInput();
        if (userInput.toLowerCase() === "exit") break;

        try {
          await this.processUserInput(userInput);
        } catch (error) {
          const err = error as ErrorWithCause;
          if (err.cause?.code === "ECONNREFUSED") {
            console.error(
              "\nError: Lost connection to Ollama server. Please ensure Ollama is running."
            );
            console.log("You can:");
            console.log("1. Start Ollama and type your message again");
            console.log('2. Type "exit" to quit\n');
          } else {
            console.error(
              "Error processing input:",
              err instanceof Error ? err.message : String(err)
            );
          }
        }
      }
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.cleanup();
    }
  }

  async handleUserInput(userInput: string): Promise<string> {
    await this.processUserInput(userInput);
    const last = this.messages[this.messages.length - 1];
    return last?.content || "(No response)";
  }

  private async processUserInput(userInput: string) {
    this.messages.push({ role: "user", content: userInput });
  
    try {
      // === 1. 查詢 RAG 記憶庫 ===
      const recallRes = await axios.post(`${RAG_API_BASE}/recall`, { text: userInput });
      const relatedDocs: any[] = recallRes.data.selected_docs || [];
  
      if (relatedDocs.length > 0) {
        console.log(`✅ 使用了 RAG，共檢索到 ${relatedDocs.length} 筆資料`);
        relatedDocs.forEach((doc, i) => {
          console.log(`📚 [${i + 1}] 來源: ${doc.source_doc || '未知'}, 時間: ${doc.created_at || '未知'}`);
          console.log(`    段落內容: ${doc.text.slice(0, 80)}...`); // 顯示部分文字
        });
  
        // === 2. 插入包含來源的背景知識 ===
        const contextText = relatedDocs.map((doc, i) => {
          const source = doc.source_doc || "未知來源";
          const time = doc.created_at || "未知時間";
          const certainty = doc._additional?.certainty !== undefined
            ? `${(doc._additional.certainty * 100).toFixed(1)}%`
            : "未知";
  
          return `[${i + 1}] 來源: ${source}，時間: ${time}\n${doc.text}`;
        }).join("\n\n");
  
        this.messages.push({
          role: "system",
          content: `
  You are an intelligent assistant equipped with two key abilities:
  1. You have access to background knowledge retrieved from a vector database (RAG). Use this information to support your answers whenever possible.
  2. You can call external tools (via tool calls) to obtain necessary data or perform actions.
  
  Below is the relevant context retrieved from the knowledge base. When answering, you must quote the relevant sources using the format [1], [2], etc.
  
  ${contextText}
          `.trim()
        });
  
      } else {
        console.log("❌ 沒有使用 RAG，查無相關知識。");
      }
  
      // === 3. 呼叫 LLM ===
      const response = await this.ollama.chat({
        model: this.model,
        messages: this.messages as any[],
        tools: this.toolManager.tools,
      });
  
      this.messages.push(response.message as OllamaMessage);
  
      // === 4. Tool 呼叫處理 ===
      const toolCalls = response.message.tool_calls ?? [];
      if (toolCalls.length > 0) {
        await this.handleToolCalls(toolCalls);
        
      } else {
        console.log("Assistant 回覆:", response.message.content);
      }
  
    } catch (error) {
      this.messages.pop(); // 移除失敗訊息
      console.error("處理過程中出錯：", error);
      throw error;
    }
  }
  
  

  private async handleToolCalls(toolCalls: any[]) {
    console.log("Model is using tools to help answer...");

    for (const toolCall of toolCalls) {
      const args = this.parseToolArguments(toolCall.function.arguments);
      console.log(`Using tool: ${toolCall.function.name}`);
      console.log(`With arguments:`, args);

      // Get parameter mapping suggestions before making the call
      const parameterMappings = this.toolManager.suggestParameterMapping(
        toolCall.function.name,
        args
      );

      // Fix parameters using the suggested mappings
      const fixedArgs = this.fixToolArguments(args, parameterMappings);
      const result = await this.toolManager.callTool(
        toolCall.function.name,
        fixedArgs
      );

      if (result) {
        console.log(`Tool result:`, result.content);

        // Check if the result contains an error
        const resultContent = result.content;
        if (
          Array.isArray(resultContent) &&
          resultContent[0]?.type === "text" &&
          resultContent[0]?.text?.includes("Error")
        ) {
          // Get tool parameter information
          const toolInfo = this.toolManager.getToolParameterInfo(
            toolCall.function.name
          );

          // Create detailed error message with parameter information
          const errorMessage = this.createDetailedErrorMessage(
            toolCall.function.name,
            resultContent[0].text,
            toolInfo,
            args,
            parameterMappings
          );

          // Add error message to conversation
          this.messages.push({
            role: "tool",
            content: errorMessage,
            tool_call_id: toolCall.function.name,
          });

          try {
            // Let the model know about the error and try again
            const errorResponse = await this.ollama.chat({
              model: this.model,
              messages: this.messages as any[],
              tools: this.toolManager.tools,
            });

            this.messages.push(errorResponse.message as OllamaMessage);

            const newToolCalls = errorResponse.message.tool_calls ?? [];
            if (newToolCalls.length > 0) {
              // Don't recurse if we're retrying the same tool with the same args
              const currentToolName = toolCall.function.name;
              const hasNewToolCalls = newToolCalls.some(
                (call) =>
                  call.function.name !== currentToolName ||
                  JSON.stringify(call.function.arguments) !==
                    JSON.stringify(toolCall.function.arguments)
              );

              if (hasNewToolCalls) {
                await this.handleToolCalls(newToolCalls);
              } else {
                console.log(
                  "There was an issue with the tool call. Trying again."
                );
                return;
              }
            }
          } catch (error) {
            const err = error as ErrorWithCause;
            if (err.cause?.code === "ECONNREFUSED") {
              throw error; // Propagate connection errors
            }
            console.error(
              "Error handling tool response:",
              err instanceof Error ? err.message : String(err)
            );
          }
          return;
        }

        // No error, proceed normally
        this.messages.push({
          role: "tool",
          content: formatToolResponse(result.content),
          tool_call_id: toolCall.function.name,
        });
      }
    }

    try {
      // Get final response after all tools in this batch are done
      const finalResponse = await this.ollama.chat({
        model: this.model,
        messages: this.messages as any[],
        tools: this.toolManager.tools,
      });

      // Add the model's response to messages
      this.messages.push(finalResponse.message as OllamaMessage);

      // Print the response regardless of whether there are tool calls
      console.log("Assistant:", finalResponse.message.content);

      // Check for new tool calls
      const newToolCalls = finalResponse.message.tool_calls ?? [];
      if (newToolCalls.length > 0) {
        // Check if the new tool calls are different from the previous ones
        const previousToolNames = new Set(
          toolCalls.map((t) => t.function.name)
        );
        const hasNewTools = newToolCalls.some(
          (call) => !previousToolNames.has(call.function.name)
        );

        if (hasNewTools) {
          await this.handleToolCalls(newToolCalls);
        }
      }
    } catch (error) {
      const err = error as ErrorWithCause;
      if (err.cause?.code === "ECONNREFUSED") {
        throw error; // Propagate connection errors
      }
      console.error(
        "Error getting final response:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private createDetailedErrorMessage(
    toolName: string,
    errorText: string,
    toolInfo: any | undefined,
    providedArgs: Record<string, unknown>,
    suggestedMappings: Record<string, string>
  ): string {
    let message = `Error using tool ${toolName}:\n${errorText}\n\n`;

    if (toolInfo) {
      message += `Expected parameters:\n`;
      message += `Required: ${toolInfo.parameters.required.join(", ")}\n`;
      message += `Available: ${Object.keys(toolInfo.parameters.properties).join(
        ", "
      )}\n\n`;

      if (Object.keys(suggestedMappings).length > 0) {
        message += `Suggested parameter mappings:\n`;
        for (const [provided, suggested] of Object.entries(suggestedMappings)) {
          message += `- ${provided} → ${suggested}\n`;
        }
      }
    }

    return message;
  }

  private fixToolArguments(
    args: Record<string, unknown>,
    mappings: Record<string, string>
  ): Record<string, unknown> {
    const fixedArgs: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(args)) {
      const mappedKey = mappings[key] || key;
      fixedArgs[mappedKey] = value;
    }

    return fixedArgs;
  }

  private parseToolArguments(
    args: string | Record<string, unknown>
  ): Record<string, unknown> {
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
