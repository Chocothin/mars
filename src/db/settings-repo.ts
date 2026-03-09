import { getDb } from './index';
import type { AppSettings } from '../types/settings';
import { DEFAULT_SETTINGS } from '../types/settings';

export function getSettings(): AppSettings {
  const db = getDb();
  const row = db.query('SELECT data FROM settings WHERE id = 1').get() as { data: string } | null;
  if (!row) return DEFAULT_SETTINGS;
  try {
    return JSON.parse(row.data) as AppSettings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const db = getDb();
  const current = getSettings();

  const merged: AppSettings = {
    general: { ...current.general, ...patch.general },
    notifications: { ...current.notifications, ...patch.notifications },
  };

  const now = Date.now();
  const data = JSON.stringify(merged);

  db.run(
    `INSERT INTO settings (id, data, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [data, now],
  );

  return merged;
}
