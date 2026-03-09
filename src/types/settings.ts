export interface AppSettings {
  general: {
    projectName: string;
    defaultProviderId: string;
    theme: 'dark' | 'light' | 'system';
    language: string;
  };
  notifications: {
    taskComplete: boolean;
    runFailed: boolean;
    agentError: boolean;
    systemUpdates: boolean;
  };
}

export interface UpdateSettingsInput {
  general?: Partial<AppSettings['general']>;
  notifications?: Partial<AppSettings['notifications']>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  general: {
    projectName: 'MARS AI Platform',
    defaultProviderId: '',
    theme: 'dark',
    language: 'en',
  },
  notifications: {
    taskComplete: true,
    runFailed: true,
    agentError: true,
    systemUpdates: false,
  },
};
