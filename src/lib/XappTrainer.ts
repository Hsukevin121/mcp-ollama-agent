// src/lib/XappTrainer.ts
import { ChatManager } from "./ChatManager";
import fs from "fs";

async function ensureToolTriggered(
    chat: ChatManager,
    prompt: string,
    expectedTool: string,
    stepName: string,
    retry: number = 3
) {
  for (let i = 0; i < retry; i++) {
    console.log(`[${stepName}] 嘗試執行：${prompt}`);
    const result = await chat.handleUserInput(prompt);

    console.log("✅ toolResults =", result.toolResults);

    const triggered = result.toolResults.some(tr => {
      const tool = tr.toolName?.trim().toLowerCase();
      const expected = expectedTool.trim().toLowerCase();
      return tool === expected || tr.result.includes(`Tool \"${expectedTool}\"`);
    });

    if (triggered) {
      console.log(`[✅ 成功] 工具 ${expectedTool} 已觸發`);
      return;
    } else {
      console.warn(`[⚠️ 警告] 工具 ${expectedTool} 第 ${i + 1} 次未成功觸發`);
    }
  }

  throw new Error(`[❌ 失敗] 工具 ${expectedTool} 在步驟 ${stepName} 中未觸發`);
}

export class XappTrainer {
  private chat: ChatManager;
  private appName = "";
  private policyId = 10000;

  constructor(chat: ChatManager) {
    this.chat = chat;
  }

  async trainXappFlow() {
    this.chat.reset();
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "");
    this.appName = `load_balance_${dateStr}_${timeStr}`;
    this.policyId = 10000 + Math.floor(Math.random() * 100);

    // 步驟設計：每步可有多個 prompt
    const steps = [
      // 1. 取得KPI並診斷
      {
        name: "Step 1: 取得KPI並診斷",
        prompts: [
          { prompt: "請執行工具 get_kpi_status 檢查目前網路狀況，不要解釋", tool: "get_kpi_status" },
          { prompt: "請根據剛才的KPI結果診斷目前網路狀態，並提出優化建議", tool: "" }
        ]
      },
      // 2. 快取記錄KPI
      {
        name: "Step 2: 快取記錄KPI",
        prompts: [
          { prompt: "請執行工具 snapshot_save 儲存目前 KPI 為 baseline，不要解釋", tool: "snapshot_save" }
        ]
      },
      // 3. 查詢所有xApp
      {
        name: "Step 3: 查詢所有xApp",
        prompts: [
          { prompt: "請執行工具 list_xapps 查看目前 xApp 列表，不要解釋", tool: "list_xapps" }
        ]
      },
      // 4. 建立新xApp（需避免重複）
      {
        name: "Step 4: 建立新xApp",
        prompts: [
          { prompt: `請執行工具 create_xapp 建立 ${this.appName}，policy_id 為 ${this.policyId}，並避免名稱或策略ID重複，不要解釋`, tool: "create_xapp" }
        ]
      },
      // 5. 再次獲取KPI
      {
        name: "Step 5: 再次獲取KPI",
        prompts: [
          { prompt: "請執行工具 get_kpi_status 檢查目前網路狀況，不要解釋", tool: "get_kpi_status" }
        ]
      },
      // 6. 查看xApp config
      {
        name: "Step 6: 查看xApp config",
        prompts: [
          { prompt: `請執行工具 view_config 查看 ${this.appName} 的設定，不要解釋`, tool: "view_config" }
        ]
      },
      // 7. 判斷是否需要修改程式碼（可根據AI回覆決定是否執行）
      {
        name: "Step 7: 判斷與修改xApp程式碼",
        prompts: [
          { prompt: `請根據以下 xapp config 判斷是否需要修改參數（如 MIN_SINR、PRB_THRESHOLD、UE_THRESHOLD），
若需修改，請直接執行工具 update_config，並提供 app_name 與完整的 config_text（C語言格式）。
不要輸出其他資訊或 JSON 格式，也不要解釋。

xapp config 檔案內容如下：
#ifndef XAPP_CONFIG_H
#define XAPP_CONFIG_H

// === 共用參數（各種 xApp 都可參考） ===
#define MAX_REGISTERED_CELLS 8
#define MAX_REGISTERED_UES 64
#define MAX_REGISTERED_NEIGHBOURS 8
#define MAX_NUM_OF_RIC_INDICATIONS 3

// === xApp 可調參數（供 AI 控制） ===
#define MIN_SINR -10           // SINR 閾值（dB）
#define PRB_THRESHOLD 40       // PRB 使用率上限（%）
#define UE_THRESHOLD 3         // 每 cell 最少 UE 數量

#endif // XAPP_CONFIG_H
`, tool: "update_config" }
        ]
      },
      {
        name: "Step 8: 再次獲取KPI",
        prompts: [
          { prompt: "請執行工具 get_kpi_status 檢查目前網路狀況，不要解釋", tool: "get_kpi_status" }
        ]
      },
      {
        name: "Step 9: 查看xApp config",
        prompts: [
          { prompt: `請執行工具 view_logic 查看 ${this.appName} 的設定，不要解釋`, tool: "view_logic" }
        ]
      },
      {
        name: "Step 10: 判斷與修改xApp程式碼",
        prompts: [
          { prompt: `請判斷剛才的 xapp config 檔案是否需要修改參數，如需修改請直接執行工具 update_logic，並提供 app_name 及完整 logic_text 內容，不要解釋。`, tool: "update_logic" }
        ]
      },
      // 8. 編譯
      {
        name: "Step 11: 編譯xApp",
        prompts: [
          { prompt: `請執行工具 compile_xapp 編譯 ${this.appName}`, tool: "compile_xapp" }
        ]
      },
      // 9. 查詢xApp運行狀態
      {
        name: "Step 12: 查詢xApp運行狀態",
        prompts: [
          { prompt: `請執行工具 status_all 查詢 xApp 狀態，不要解釋`, tool: "status_all" }
        ]
      },
      // 10. 停止舊xApp
      {
        name: "Step 13: 停止舊xApp",
        prompts: [
          { prompt: `請執行工具 stop_xapp 停止目前運行中的 xApp，不要解釋`, tool: "stop_xapp" }
        ]
      },
      // 11. 啟動新xApp
      {
        name: "Step 14: 啟動新xApp",
        prompts: [
          { prompt: `請執行工具 start_xapp 啟動 ${this.appName}，不要解釋`, tool: "start_xapp" }
        ]
      },
      // 12. 快取新KPI
      {
        name: "Step 15: 快取新KPI",
        prompts: [
          { prompt: "請執行工具 snapshot_save 儲存執行後 KPI，不要解釋", tool: "snapshot_save" }
        ]
      },
      // 13. 比較新舊KPI
      {
        name: "Step 16: 比較新舊KPI",
        prompts: [
          { prompt: "請執行工具 snapshot_compare 比對前後 KPI，不要解釋", tool: "snapshot_compare" }
        ]
      }
    ];

    // 執行流程
    for (const step of steps) {
      // Step 15 前先休息 10 分鐘
      if (step.name === "Step 15: 快取新KPI") {
        console.log("⏳ 等待 10 分鐘再獲取新 KPI...");
        await new Promise(res => setTimeout(res, 10 * 60 * 1000));
      }
      for (const p of step.prompts) {
        try {
          if (p.tool) {
            await ensureToolTriggered(this.chat, p.prompt, p.tool, step.name);
          } else {
            await this.chat.handleUserInput(p.prompt);
          }
        } catch (err) {
          console.error(`[流程中止] ${step.name} 失敗`);
          throw err;
        }
      }
    }

    console.log(`✅ 完成自我優化訓練流程：${this.appName}（policy_id: ${this.policyId}）`);
  }
}
