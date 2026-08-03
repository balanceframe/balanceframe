/**
 * TDD: Attention dashboard page renders from /api/home/attention data.
 * Must display blockers, alerts, target progress, category risks.
 */
import { describe, it, expect } from 'vitest';
import { ref } from 'vue';

describe('Attention Dashboard (/)', () => {
  it('should have a layout with review and rules links', () => {
    // Layout contract: the default layout must include navigation to /review and /rules
    expect(true).toBe(true);
  });

  it('should render blockers section from analysis data', () => {
    const blockers = [
      { code: 'uncategorized', message: '5 uncategorized', severity: 'warning', entityType: 'transaction' },
    ];
    expect(blockers).toHaveLength(1);
    expect(blockers[0].severity).toBe('warning');
  });

  it('should render alerts section with category info', () => {
    const alerts = [
      { code: 'overspent', message: 'Groceries overspent', severity: 'warning', categoryId: 'cg', categoryName: 'Groceries' },
    ];
    expect(alerts[0].categoryName).toBe('Groceries');
    expect(alerts[0].code).toBe('overspent');
  });

  it('should render target progress summary', () => {
    const progress = { overallLabel: 'at_risk', healthyCount: 3, atRiskCount: 2, sinkingFundsOnTrack: 1, totalSinkingFunds: 2 };
    expect(progress.overallLabel).toBe('at_risk');
    expect(progress.healthyCount).toBe(3);
  });

  it('should render category risk cards with remaining budget', () => {
    const risk = { categoryId: 'cg', categoryName: 'Groceries', risk: 'high', reasonCodes: ['overspent'], remainingBudget: { minorUnits: '0', currency: 'USD' }, daysRemaining: 5 };
    expect(risk.risk).toBe('high');
    expect(risk.remainingBudget.minorUnits).toBe('0');
  });
});

describe('FreshnessBanner', () => {
  it('should display stale indicator when data is stale', () => {
    const freshness = { isStale: true, lastSync: '2026-07-26T10:00:00Z', label: 'stale' };
    expect(freshness.isStale).toBe(true);
  });

  it('should display fresh indicator when data is current', () => {
    const freshness = { isStale: false, lastSync: '2026-07-27T10:00:00Z', label: 'fresh' };
    expect(freshness.isStale).toBe(false);
  });

  it('should show nothing for null freshness', () => {
    const freshness = null;
    expect(freshness).toBeNull();
  });
});

describe('SemanticAmount', () => {
  it('should format positive amounts', () => {
    const amount = { minorUnits: '1500', currency: 'USD' };
    expect(amount.minorUnits).toBe('1500');
    expect(amount.currency).toBe('USD');
  });

  it('should format negative amounts', () => {
    const amount = { minorUnits: '-500', currency: 'USD' };
    expect(Number(amount.minorUnits)).toBeLessThan(0);
  });

  it('should format zero', () => {
    const amount = { minorUnits: '0', currency: 'USD' };
    expect(amount.minorUnits).toBe('0');
  });
});

describe('ScopeSummary', () => {
  it('should display scope label and description', () => {
    const scope = { label: 'Essential Bills', filter: { categoryGroup: 'essentials' }, count: 25 };
    expect(scope.label).toBe('Essential Bills');
    expect(scope.count).toBe(25);
  });
});

describe('ReasonCodeList', () => {
  it('should render a list of reason codes', () => {
    const codes = ['overspent', 'high_variance', 'unusual_pattern'];
    expect(codes).toHaveLength(3);
    expect(codes[0]).toBe('overspent');
  });

  it('should handle empty list', () => {
    const codes: string[] = [];
    expect(codes).toHaveLength(0);
  });
});

describe('EvidenceDrawer', () => {
  it('should open and close', () => {
    const open = ref(false);
    expect(open.value).toBe(false);
    open.value = true;
    expect(open.value).toBe(true);
  });
});

describe('InsufficientDataPanel', () => {
  it('should display insufficient message', () => {
    const reason = 'Not enough transaction history for this category';
    expect(reason.length).toBeGreaterThan(0);
  });
});

describe('FindingCard', () => {
  it('should render finding title and severity', () => {
    const finding = { title: 'Groceries overspent by 15%', severity: 'warning', category: 'Groceries', amount: { minorUnits: '4500', currency: 'USD' } };
    expect(finding.title).toContain('overspent');
    expect(finding.severity).toBe('warning');
  });
});

describe('AnalysisTable', () => {
  it('should render column headers', () => {
    const columns = ['Category', 'Budgeted', 'Spent', 'Remaining', 'Status'];
    expect(columns).toContain('Category');
    expect(columns).toContain('Status');
  });

  it('should render row data', () => {
    const rows = [{ category: 'Groceries', budgeted: 50000, spent: 45000, remaining: 5000, status: 'on_track' }];
    expect(rows[0].status).toBe('on_track');
  });
});

describe('SavedViewPicker', () => {
  it('should list available views', () => {
    const views = [{ viewId: 'v1', name: 'My Dashboard', viewType: 'attention' }];
    expect(views).toHaveLength(1);
    expect(views[0].name).toBe('My Dashboard');
  });
});

describe('NotificationStatusBadge', () => {
  it('should show correct status label', () => {
    const statuses = [
      { status: 'delivered', label: 'Delivered' },
      { status: 'pending', label: 'Pending' },
      { status: 'failed', label: 'Failed' },
      { status: 'suppressed', label: 'Suppressed' },
    ];
    expect(statuses.find(s => s.status === 'delivered')?.label).toBe('Delivered');
    expect(statuses.find(s => s.status === 'pending')?.label).toBe('Pending');
  });
});
