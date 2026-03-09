import type { SimpleApprovalConfig } from './types';

export const DEFAULT_APPROVAL_CONFIG: SimpleApprovalConfig = {
  approvalRequired: false,
  timeoutMs: 5 * 60 * 1000,
  fallbackAction: 'auto_approve',
};

export function getApprovalOffConfig(): SimpleApprovalConfig {
  return {
    approvalRequired: false,
    timeoutMs: 0,
    fallbackAction: 'auto_approve',
  };
}
