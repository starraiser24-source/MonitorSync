import { display } from '@kit.ArkUI';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { wantAgent } from '@kit.AbilityKit';
import { common } from '@kit.AbilityKit';
import streamer from 'libstreamer.so';

const STREAM_PORT = 27183;

interface StreamSize {
  width: number;
  height: number;
}

@Entry
@Component
struct Index {
  @State isStreaming: boolean = false;
  @State statusText: string = '就绪 · 等待开启 60fps 硬件推流';
  @State resolutionLabel: string = '720×1600 @ 60fps';
  @StorageLink('autoStartNonce') @Watch('onAutoStartSignal') autoStartNonce: number = 0;

  onAutoStartSignal(): void {
    if (this.autoStartNonce > 0 && !this.isStreaming) {
      void this.startStreaming();
    }
  }

  aboutToAppear(): void {
    const dims = this.computeStreamDimensions();
    this.resolutionLabel = `${dims.width}×${dims.height} @ 60fps`;
    if (this.autoStartNonce > 0 && !this.isStreaming) {
      void this.startStreaming();
    }
  }

  aboutToDisappear(): void {
    this.stopStreaming();
  }

  private computeStreamDimensions(): StreamSize {
    try {
      const disp = display.getDefaultDisplaySync();
      const maxLong = 1280;
      const scale = Math.min(1, maxLong / Math.max(disp.width, disp.height));
      // Align to 16px boundary required by H.264 hardware encoders
      const width = Math.max(368, Math.floor((disp.width * scale) / 16) * 16);
      const height = Math.max(368, Math.floor((disp.height * scale) / 16) * 16);
      const result: StreamSize = { width: width, height: height };
      return result;
    } catch {
      const fallback: StreamSize = { width: 576, height: 1280 };
      return fallback;
    }
  }

  private async startBackgroundTask(): Promise<void> {
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const info: wantAgent.WantAgentInfo = {
        wants: [{ bundleName: context.abilityInfo.bundleName, abilityName: 'EntryAbility' }],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0,
        actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
      };
      const agent = await wantAgent.getWantAgent(info);
      await backgroundTaskManager.startBackgroundRunning(
        context,
        backgroundTaskManager.BackgroundMode.MULTI_DEVICE_CONNECTION,
        agent
      );
    } catch {
      // Non-fatal if background task is already running or restricted
    }
  }

  private async stopBackgroundTask(): Promise<void> {
    try {
      const context = getContext(this) as common.UIAbilityContext;
      await backgroundTaskManager.stopBackgroundRunning(context);
    } catch {
      // ignore
    }
  }

  private async startStreaming(): Promise<void> {
    if (this.isStreaming) return;
    const dims = this.computeStreamDimensions();
    this.resolutionLabel = `${dims.width}×${dims.height} @ 60fps`;
    await this.startBackgroundTask();
    const ok = streamer.start(dims.width, dims.height, 60, 8_000_000, STREAM_PORT);
    if (ok) {
      this.isStreaming = true;
      this.statusText = `H.264 60fps 硬件推流中 · 端口 ${STREAM_PORT}`;
    } else {
      this.statusText = '启动推流失败，请检查录屏权限并重试';
    }
  }

  private stopStreaming(): void {
    if (!this.isStreaming) return;
    streamer.stop();
    this.isStreaming = false;
    this.statusText = '已停止推流';
    void this.stopBackgroundTask();
  }

  build() {
    Column({ space: 20 }) {
      Text('MonitorSync 60fps')
        .fontSize(26)
        .fontWeight(FontWeight.Bold)
        .fontColor('#FFFFFF')

      Text('HarmonyOS NEXT 硬件 H.264 同屏引擎')
        .fontSize(13)
        .fontColor('#94A3B8')

      Column({ space: 10 }) {
        Text(this.statusText)
          .fontSize(14)
          .fontColor(this.isStreaming ? '#34D399' : '#E2E8F0')
          .textAlign(TextAlign.Center)

        Text(`输出规格：${this.resolutionLabel}`)
          .fontSize(12)
          .fontColor('#64748B')
      }
      .width('100%')
      .padding(20)
      .borderRadius(16)
      .backgroundColor('#131722')

      Button(this.isStreaming ? '停止 60fps 投屏' : '开启 60fps H.264 投屏')
        .width('100%')
        .height(48)
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .backgroundColor(this.isStreaming ? '#E11D48' : '#0284C7')
        .fontColor('#FFFFFF')
        .borderRadius(12)
        .onClick(() => {
          if (this.isStreaming) {
            this.stopStreaming();
          } else {
            void this.startStreaming();
          }
        })

      Text('开启并允许系统录屏后，可切回桌面或任意 App，电脑端 MonitorSync 将自动接入 60fps H.264 硬件流。')
        .fontSize(12)
        .fontColor('#64748B')
        .textAlign(TextAlign.Center)
        .lineHeight(18)
    }
    .width('100%')
    .height('100%')
    .padding(28)
    .justifyContent(FlexAlign.Center)
    .backgroundColor('#0B0D12')
  }
}
