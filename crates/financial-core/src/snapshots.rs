use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::money::Money;

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub account_type: String,
    pub off_budget: bool,
    pub is_closed: bool,
    pub cleared_balance: Money,
    pub imported_balance: Money,
    pub mtid: Option<String>,
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub id: String,
    pub account_id: String,
    pub date: String,
    pub payee_id: Option<String>,
    pub payee_name: Option<String>,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    pub amount: Money,
    pub cleared: bool,
    pub reconciled: bool,
    pub imported_id: Option<String>,
    pub imported_payee: Option<String>,
    pub notes: Option<String>,
    pub tags: Vec<String>,
    pub transfer_account_id: Option<String>,
    pub subtransactions: Vec<Transaction>,
}

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    pub group_name: Option<String>,
    pub is_income: bool,
    pub mtid: Option<String>,
    pub deleted: bool,
}

// ---------------------------------------------------------------------------
// Payee
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Payee {
    pub id: String,
    pub name: String,
    pub transfer_account_id: Option<String>,
    pub mtid: Option<String>,
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub frequency: String,
    pub amount: Money,
    pub payee_name: Option<String>,
    pub account_id: String,
    pub next_expected: String,
}

// ---------------------------------------------------------------------------
// BudgetMonth / BudgetCategory
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetCategory {
    pub category_id: String,
    pub amount: Money,
    pub carryover: Money,
    pub carryover_from_previous: Money,
    pub carries_over: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetMonth {
    pub id: String,
    pub month: String,
    pub categories: HashMap<String, BudgetCategory>,
}

// ---------------------------------------------------------------------------
// Tag
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
}

// ---------------------------------------------------------------------------
// Rule
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub order: u32,
    pub trigger: serde_json::Value,
    pub actions: serde_json::Value,
    pub inactive: bool,
}

// ---------------------------------------------------------------------------
// ImportTransaction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTransaction {
    pub id: String,
    pub account_id: String,
    pub date: String,
    pub payee_name: Option<String>,
    pub amount: Money,
    pub memo: Option<String>,
    pub flags_count: u32,
}
