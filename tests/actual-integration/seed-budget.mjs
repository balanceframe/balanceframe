import * as actualApi from '@actual-app/api';
import { readFileSync } from 'fs';

// Map canonical protocol accountType to Actual API account type
function mapAccountType(t) {
  switch (t) {
    case 'checking':
      return 'checking';
    case 'savings':
      return 'savings';
    case 'creditCard':
      return 'credit';
    case 'cash':
    case 'investment':
    case 'loan':
    case 'other':
      return 'other';
    default:
      return 'other';
  }
}

const FIXTURE_ARRAY_FIELDS = [
  'accounts',
  'categories',
  'categoryGroups',
  'payees',
  'transactions',
  'rules',
  'schedules',
  'budgets',
  'tags',
];

function loadFixture(fixturePath) {
  if (!fixturePath) {
    throw new Error('Fixture path is missing: FIXTURE_DATA_PATH is not set');
  }

  let contents;
  try {
    contents = readFileSync(fixturePath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Unable to read fixture "${fixturePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let fixture;
  try {
    fixture = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Unable to parse fixture JSON "${fixturePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (fixture === null || typeof fixture !== 'object' || Array.isArray(fixture)) {
    throw new Error(`Fixture "${fixturePath}" must contain a JSON object`);
  }
  for (const field of FIXTURE_ARRAY_FIELDS) {
    const entries = fixture[field];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      throw new Error(`Fixture "${fixturePath}" field "${field}" must be an array`);
    }
    for (const [index, entry] of entries.entries()) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(
          `Fixture "${fixturePath}" field "${field}" entry ${index} must be an object`,
        );
      }
    }
  }
  for (const [groupIndex, group] of (fixture.categoryGroups || []).entries()) {
    if (group.categories !== undefined && !Array.isArray(group.categories)) {
      throw new Error(
        `Fixture "${fixturePath}" field "categoryGroups" entry ${groupIndex} ` +
          'must have a categories array',
      );
    }
    for (const [categoryIndex, category] of (group.categories || []).entries()) {
      if (category === null || typeof category !== 'object' || Array.isArray(category)) {
        throw new Error(
          `Fixture "${fixturePath}" categoryGroups entry ${groupIndex} ` +
            `category ${categoryIndex} must be an object`,
        );
      }
    }
  }

  return fixture;
}

function parseTransactionAmount(amount, fixturePath, transactionLabel) {
  if (typeof amount === 'number' && Number.isSafeInteger(amount)) {
    return amount;
  }
  if (
    amount !== null &&
    typeof amount === 'object' &&
    !Array.isArray(amount) &&
    typeof amount.minorUnits === 'string' &&
    /^-?\d+$/.test(amount.minorUnits)
  ) {
    const minorUnits = Number(amount.minorUnits);
    if (Number.isSafeInteger(minorUnits)) {
      return minorUnits;
    }
  }

  throw new Error(
    `Fixture "${fixturePath}" transaction "${transactionLabel}" has a malformed amount: ` +
      JSON.stringify(amount),
  );
}

// Helper: resolve a category-group ID from createCategoryGroup return value.
// The API may return a string ID directly, or empty — in which case we
// refresh the group list and locate the newly created group by name.
async function resolveGroupId(name, directResult) {
  if (directResult && typeof directResult === 'string' && directResult.length > 0) {
    return directResult;
  }
  // Fallback: look up the group we just created
  const groups = await actualApi.getCategoryGroups();
  const found = groups.find((g) => g.name === name);
  if (!found || !found.id) {
    throw new Error(
      `Actual did not create category group "${name}" ` +
        `(createCategoryGroup returned ${JSON.stringify(directResult)}, ` +
        `getCategoryGroups returned ${JSON.stringify(groups.map((g) => ({ id: g.id, name: g.name })))})`,
    );
  }
  return found.id;
}

async function main() {
  const serverUrl = process.env.ACTUAL_SERVER_URL;
  const password = process.env.ACTUAL_SECRET_KEY;
  const budgetName = process.env.ACTUAL_BUDGET_NAME;
  const fixturePath = process.env.FIXTURE_DATA_PATH;
  const fixture = loadFixture(fixturePath);

  // Initialize connection
  const client = await actualApi.init({
    serverURL: serverUrl,
    password,
    dataDir: process.env.SEED_DATA_DIR,
  });

  // Create budget and resolve identity
  await client.send('create-budget', {
    budgetName,
    avoidUpload: false,
  });
  const budgets = await actualApi.getBudgets();

  // getBudgets() may return separate local and cloud entries for the same budget.
  // Prefer cloudBudget.cloudFileId (the remote listing identifier) first, then
  // cloudBudget.id, then localBudget?.id — because a fresh Actual client exposes
  // the cloud file UUID as cloudFileId when id is absent from the remote response.
  // ActualConnector.discoverBudgets uses cloudFileId as the public identifier,
  // so this ordering matches discoverBudgets for a freshly-seeded setup.
  const localBudget = budgets.find((c) => c.name === budgetName && 'id' in c && Boolean(c.id));
  const cloudBudget = budgets.find((c) => c.name === budgetName && Boolean(c.groupId));
  if (!cloudBudget) {
    throw new Error(
      `Created budget "${budgetName}" was not fully synchronized with the server. Cloud entry missing.`,
    );
  }
  // Resolve the budget ID the same way ActualConnector.discoverBudgets does:
  // cloudFileId ?? id ?? '' — cloudBudget.cloudFileId (remote UUID) takes priority
  // because a fresh setup only has cloudFileId as the true public identifier.
  const resolvedBudgetId = cloudBudget.cloudFileId ?? cloudBudget.id ?? localBudget?.id ?? '';
  if (!resolvedBudgetId) {
    throw new Error(
      `Could not resolve a budget ID for "${budgetName}" ` +
        `(cloudBudget.id=${JSON.stringify(cloudBudget?.id)}, ` +
        `cloudFileId=${JSON.stringify(cloudBudget?.cloudFileId)}, ` +
        `localBudget.id=${JSON.stringify(localBudget?.id)})`,
    );
  }
  const groupId = cloudBudget.groupId;

  console.log(
    JSON.stringify({
      status: 'budget_created',
      budgetId: resolvedBudgetId,
      groupId,
      name: budgetName,
    }),
  );

  // ---- Categories (canonical flat or legacy grouped) ----
  if (fixture.categories && fixture.categories.length > 0) {
    // Canonical protocol shape: flat categories with groupName field.
    // Group by groupName and create one category group per distinct name.
    const groupByName = {};
    for (const cat of fixture.categories) {
      if (cat.deleted) continue;
      if (!groupByName[cat.groupName]) {
        groupByName[cat.groupName] = await resolveGroupId(
          cat.groupName,
          await actualApi.createCategoryGroup({ name: cat.groupName }),
        );
      }
      // Ensure the group id resolved to a non-empty value before creating the category.
      if (!groupByName[cat.groupName]) {
        throw new Error(
          `Category group "${cat.groupName}" has no resolved group_id; ` +
            `createCategoryGroup result was ${JSON.stringify(groupByName[cat.groupName])}`,
        );
      }

      await actualApi.createCategory({
        name: cat.name,
        group_id: groupByName[cat.groupName],
        isIncome: cat.isIncome || false,
        hidden: false,
      });
    }
  } else if (fixture.categoryGroups) {
    // Legacy inline fixture shape: nested categoryGroups
    for (const group of fixture.categoryGroups) {
      const resolvedId = await resolveGroupId(
        group.name,
        await actualApi.createCategoryGroup({ name: group.name }),
      );
      for (const cat of group.categories || []) {
        // Ensure the group id resolved to a non-empty value before creating the category.
        if (!resolvedId) {
          throw new Error(
            `Category group "${group.name}" has no resolved group_id; ` +
              `createCategoryGroup result was ${JSON.stringify(resolvedId)}`,
          );
        }

        await actualApi.createCategory({
          name: cat.name,
          group_id: resolvedId,
          isIncome: cat.isIncome || false,
          hidden: cat.hidden || false,
        });
      }
    }
  }

  // ---- Accounts (canonical fields or legacy fields) ----
  if (fixture.accounts) {
    for (const acct of fixture.accounts) {
      // Canonical: accountType / offBudget / isClosed  |  Legacy: type / offbudget / closed
      const type = acct.accountType ? mapAccountType(acct.accountType) : acct.type || 'other';
      const offbudget = acct.offBudget !== undefined ? acct.offBudget : acct.offbudget || false;
      const closed = acct.isClosed !== undefined ? acct.isClosed : acct.closed || false;
      await actualApi.createAccount({ name: acct.name, type, offbudget, closed });
    }
  }

  // Build name-based and fixture-id based maps after entity creation
  const accounts = await actualApi.getAccounts();
  const accountByName = {};
  const acctIdByFixId = {};
  for (const a of accounts) {
    const aName = a.name;
    accountByName[aName] = a.id;
  }
  for (const fa of fixture.accounts || []) {
    if (typeof fa.id === 'string' && fa.name && accountByName[fa.name]) {
      acctIdByFixId[fa.id] = accountByName[fa.name];
    }
  }

  // ---- Payees (canonical with transferAccountId or legacy with transferAcct) ----
  if (fixture.payees) {
    for (const payee of fixture.payees) {
      let transferAcct = null;
      if (payee.transferAccountId) {
        // Canonical: fixture-id reference → resolve to actual account ID
        transferAcct = acctIdByFixId[payee.transferAccountId] || null;
      } else if (payee.transferAcct) {
        // Legacy: direct value
        transferAcct = payee.transferAcct;
      }
      await actualApi.createPayee({ name: payee.name, transferAcct });
    }
  }

  // Build name-based payee and category maps
  const payeeByName = {};
  for (const p of await actualApi.getPayees()) payeeByName[p.name] = p.id;
  const catByName = {};
  for (const c of await actualApi.getCategories()) catByName[c.name] = c.id;
  // Also build fixture-id → name maps for canonical transaction resolution
  const payeeNameByFixId = {};
  for (const fp of fixture.payees || []) payeeNameByFixId[fp.id] = fp.name;
  const catNameByFixId = {};
  for (const fc of fixture.categories || []) catNameByFixId[fc.id] = fc.name;
  const accountIds = { ...acctIdByFixId };
  const categoryIds = {};
  for (const fc of fixture.categories || []) {
    if (!fc.deleted && typeof fc.id === 'string' && fc.name && catByName[fc.name]) {
      categoryIds[fc.id] = catByName[fc.name];
    }
  }
  const payeeIds = {};
  for (const fp of fixture.payees || []) {
    if (typeof fp.id === 'string' && fp.name && payeeByName[fp.name]) {
      payeeIds[fp.id] = payeeByName[fp.name];
    }
  }

  // ---- Transactions (canonical or legacy shape) ----
  if (fixture.transactions) {
    for (const [transactionIndex, txn] of fixture.transactions.entries()) {
      // Resolve account: canonical accountId → fix-id map, or legacy account name
      let acctId;
      if (txn.accountId) {
        acctId = acctIdByFixId[txn.accountId];
      } else {
        acctId = accountByName[txn.account];
      }
      if (!acctId) {
        const accountReference = txn.accountId ?? txn.account;
        throw new Error(
          `Fixture "${fixturePath}" transaction "${txn.id ?? transactionIndex}" ` +
            `references an unresolved account ${JSON.stringify(accountReference)}`,
        );
      }

      // Resolve payee: canonical payeeName, or legacy payee name string
      let payee = null;
      if (txn.payeeName) {
        payee = payeeByName[txn.payeeName] || null;
      } else if (txn.payee) {
        payee = payeeByName[txn.payee] || txn.payee;
      } else if (txn.payeeId) {
        const name = payeeNameByFixId[txn.payeeId];
        if (name) payee = payeeByName[name] || null;
      }

      // Resolve category: canonical categoryName, or legacy category name string
      let category = null;
      if (txn.categoryName) {
        category = catByName[txn.categoryName] || null;
      } else if (txn.category) {
        category = catByName[txn.category] || txn.category;
      } else if (txn.categoryId) {
        const name = catNameByFixId[txn.categoryId];
        if (name) category = catByName[name] || null;
      }

      const amount = parseTransactionAmount(txn.amount, fixturePath, txn.id ?? transactionIndex);

      await actualApi.addTransactions(acctId, [
        {
          date: txn.date,
          amount,
          payee,
          category,
          notes: txn.notes || '',
          cleared: txn.cleared !== false,
        },
      ]);
    }
  }

  // Create rules
  if (fixture.rules) {
    for (const rule of fixture.rules) {
      await actualApi.createRule({
        stage: rule.stage || null,
        conditionsOp: rule.conditionsOp || 'and',
        conditions: rule.conditions || [],
        actions: rule.actions || [],
      });
    }
  }

  // Create schedules
  if (fixture.schedules) {
    for (const schedule of fixture.schedules) {
      let payee = null;
      if (schedule.payeeName) {
        payee = payeeByName[schedule.payeeName] || null;
      } else if (schedule.payee) {
        payee = payeeByName[schedule.payee] || schedule.payee;
      }
      await actualApi.createSchedule({
        name: schedule.name,
        type: schedule.type || 'bill',
        amount: schedule.amount || 0,
        startDate: schedule.startDate,
        frequency: schedule.frequency || 'monthly',
        payee,
      });
    }
  }

  // Sync to server so the seeded data is uploaded
  await actualApi.sync();

  await actualApi.shutdown();
  console.log(
    JSON.stringify({
      status: 'seeded',
      budgetId: resolvedBudgetId,
      groupId,
      serverUrl: process.env.ACTUAL_SERVER_URL,
      budgetName,
      accountIds,
      categoryIds,
      payeeIds,
    }),
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ status: 'error', message: err.message, stack: err.stack }));
  process.exit(1);
});
