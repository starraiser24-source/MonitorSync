import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';

export default class EntryAbility extends UIAbility {
  private triggerAutoStart(want: Want): void {
    const autoStart = want.parameters?.['autostart'] === true || want.parameters?.['autostart'] === 'true';
    if (autoStart) {
      AppStorage.setOrCreate('autoStartNonce', Date.now());
    }
  }

  onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    this.triggerAutoStart(want);
  }

  onNewWant(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    this.triggerAutoStart(want);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index');
  }
}
