use super::*;

// -- Complete -----------------------------------------------------------

#[test]
fn test_complete_when_current_equals_goal() {
    let status = compute_target_status(
        "tgt_1",
        "Vacation",
        &Money::new(100_000, "USD"),
        &Money::new(100_000, "USD"),
        &Money::new(10_000, "USD"),
        6,
        12,
    );
    assert_eq!(status.health, TargetHealth::Complete);
    assert_eq!(status.progress_percent, 100.0);
    assert!(status.months_remaining.is_none());
}

#[test]
fn test_complete_when_exceeds_goal() {
    let status = compute_target_status(
        "tgt_2",
        "Emergency Fund",
        &Money::new(50_000, "USD"),
        &Money::new(75_000, "USD"),
        &Money::new(5_000, "USD"),
        12,
        12,
    );
    assert_eq!(status.health, TargetHealth::Complete);
    assert_eq!(status.progress_percent, 100.0);
}

#[test]
fn test_complete_at_exact_goal() {
    let status = compute_target_status(
        "tgt_exact",
        "New Laptop",
        &Money::new(200_000, "USD"),
        &Money::new(200_000, "USD"),
        &Money::zero("USD"),
        10,
        10,
    );
    assert_eq!(status.health, TargetHealth::Complete);
    assert_eq!(status.progress_percent, 100.0);
}

// -- OnTrack ------------------------------------------------------------

#[test]
fn test_on_track_when_meeting_pace() {
    let status = compute_target_status(
        "tgt_3",
        "Car Fund",
        &Money::new(120_000, "USD"),
        &Money::new(60_000, "USD"),
        &Money::new(10_000, "USD"),
        6,
        12,
    );
    assert_eq!(status.health, TargetHealth::OnTrack);
    assert!((49.0..=51.0).contains(&status.progress_percent));
    // Remaining: (120000 - 60000) / 10000 = 6 months
    assert_eq!(status.months_remaining, Some(6));
}

#[test]
fn test_on_track_exceeding_pace() {
    let status = compute_target_status(
        "tgt_4",
        "Travel",
        &Money::new(60_000, "USD"),
        &Money::new(40_000, "USD"),
        &Money::new(10_000, "USD"),
        3,
        12,
    );
    // Expected at 3 months: 60k * 3/12 = 15k. Current is 40k → ahead → OnTrack
    assert_eq!(status.health, TargetHealth::OnTrack);
}

#[test]
fn test_on_track_zero_elapsed() {
    let status = compute_target_status(
        "tgt_new",
        "New Target",
        &Money::new(120_000, "USD"),
        &Money::zero("USD"),
        &Money::new(10_000, "USD"),
        0,
        12,
    );
    // No time elapsed, so cannot be behind
    assert_eq!(status.health, TargetHealth::OnTrack);
    assert_eq!(status.progress_percent, 0.0);
    assert_eq!(status.months_remaining, Some(12));
}

// -- Behind -------------------------------------------------------------

#[test]
fn test_behind_when_below_expected_pace() {
    let status = compute_target_status(
        "tgt_5",
        "House Down Payment",
        &Money::new(240_000, "USD"),
        &Money::new(30_000, "USD"),
        &Money::new(10_000, "USD"),
        6,
        12,
    );
    // Expected at 6 months: 240k * 6/12 = 120k. Current is 30k → Behind
    assert_eq!(status.health, TargetHealth::Behind);
}

#[test]
fn test_behind_when_nothing_saved() {
    let status = compute_target_status(
        "tgt_6",
        "Wedding",
        &Money::new(100_000, "USD"),
        &Money::zero("USD"),
        &Money::new(5_000, "USD"),
        10,
        12,
    );
    // Expected at 10 months: 100k * 10/12 ≈ 83k. Current is 0 → Behind
    assert_eq!(status.health, TargetHealth::Behind);
}

// -- Edge cases ---------------------------------------------------------

#[test]
fn test_zero_goal_amount() {
    let status = compute_target_status(
        "tgt_zero",
        "No Goal",
        &Money::zero("USD"),
        &Money::zero("USD"),
        &Money::zero("USD"),
        0,
        0,
    );
    assert_eq!(status.health, TargetHealth::Complete);
    assert_eq!(status.progress_percent, 100.0);
    assert!(status.months_remaining.is_none());
}

#[test]
fn test_zero_total_months() {
    let status = compute_target_status(
        "tgt_no_time",
        "Flexible",
        &Money::new(100_000, "USD"),
        &Money::new(50_000, "USD"),
        &Money::new(10_000, "USD"),
        0,
        0,
    );
    // No time frame → not behind (can't compute expectation)
    assert_eq!(status.health, TargetHealth::OnTrack);
    assert!(status.months_remaining.is_some());
}

#[test]
fn test_zero_contribution() {
    let status = compute_target_status(
        "tgt_no_contrib",
        "Legacy",
        &Money::new(100_000, "USD"),
        &Money::new(50_000, "USD"),
        &Money::zero("USD"),
        6,
        12,
    );
    assert_eq!(status.health, TargetHealth::OnTrack); // at 50% at 6mo of 12mo → exactly on pace
    assert!(status.months_remaining.is_none()); // can't estimate
}

#[test]
fn test_overfunding() {
    let status = compute_target_status(
        "tgt_over",
        "Overfunded",
        &Money::new(50_000, "USD"),
        &Money::new(100_000, "USD"),
        &Money::new(5_000, "USD"),
        12,
        12,
    );
    assert_eq!(status.health, TargetHealth::Complete);
    assert_eq!(status.progress_percent, 100.0);
    assert!(status.months_remaining.is_none());
}

#[test]
fn test_progress_percent_halfway() {
    let goal = Money::new(200_000, "USD");
    let current = Money::new(100_000, "USD");
    assert!((49.9..=50.1).contains(&compute_progress_percent(&goal, &current)));
}

#[test]
fn test_progress_percent_zero() {
    assert_eq!(
        compute_progress_percent(&Money::new(100_000, "USD"), &Money::zero("USD")),
        0.0,
    );
}

// -- CamelCase JSON keys ------------------------------------------------

#[test]
fn test_target_status_camelcase_keys() {
    let status = compute_target_status(
        "tgt_json",
        "Test",
        &Money::new(100_000, "USD"),
        &Money::new(50_000, "USD"),
        &Money::new(10_000, "USD"),
        5,
        10,
    );
    let json = serde_json::to_string(&status).unwrap();
    assert!(json.contains("targetId"));
    assert!(json.contains("targetName"));
    assert!(json.contains("goalAmount"));
    assert!(json.contains("currentAmount"));
    assert!(json.contains("monthlyContribution"));
    assert!(json.contains("progressPercent"));
    assert!(json.contains("monthsRemaining"));
}

#[test]
fn test_target_status_roundtrip() {
    let status = compute_target_status(
        "tgt_rt",
        "Round Trip",
        &Money::new(100_000, "USD"),
        &Money::new(50_000, "USD"),
        &Money::new(10_000, "USD"),
        5,
        10,
    );
    let json = serde_json::to_string(&status).unwrap();
    let back: TargetStatus = serde_json::from_str(&json).unwrap();
    assert_eq!(status, back);
}

// -- compute_months_remaining edge cases -------------------------------

#[test]
fn test_months_remaining_exact() {
    let goal = Money::new(100_000, "USD");
    let current = Money::new(70_000, "USD");
    let monthly = Money::new(10_000, "USD");
    // remaining = 30000, contrib = 10000 → 3 months
    let result = compute_months_remaining(&goal, &current, &monthly);
    assert_eq!(result, Some(3));
}

#[test]
fn test_months_remaining_rounds_up() {
    let goal = Money::new(100_000, "USD");
    let current = Money::new(70_001, "USD");
    let monthly = Money::new(10_000, "USD");
    // remaining = 29999, ceil(29999/10000) = 3
    let result = compute_months_remaining(&goal, &current, &monthly);
    assert_eq!(result, Some(3));
}

#[test]
fn test_months_remaining_none_when_met() {
    let goal = Money::new(100_000, "USD");
    let current = Money::new(100_000, "USD");
    let monthly = Money::new(10_000, "USD");
    assert!(compute_months_remaining(&goal, &current, &monthly).is_none());
}

#[test]
fn test_months_remaining_none_when_zero_contrib() {
    let goal = Money::new(100_000, "USD");
    let current = Money::new(50_000, "USD");
    let monthly = Money::zero("USD");
    assert!(compute_months_remaining(&goal, &current, &monthly).is_none());
}

// -- is_behind edge cases ----------------------------------------------

#[test]
fn test_is_behind_zero_elapsed() {
    let goal = Money::new(100_000, "USD");
    let current = Money::zero("USD");
    assert!(!is_behind(&goal, &current, 0, 12));
}

#[test]
fn test_is_behind_zero_total_months() {
    let goal = Money::new(100_000, "USD");
    let current = Money::zero("USD");
    assert!(!is_behind(&goal, &current, 5, 0));
}

// -- New fields: label, assumptions, uncertainty ----------------------

#[test]
fn test_target_status_label_is_advice() {
    let status = compute_target_status(
        "tgt_lbl",
        "Label Test",
        &Money::new(100_000, "USD"),
        &Money::new(50_000, "USD"),
        &Money::new(10_000, "USD"),
        5,
        10,
    );
    assert_eq!(status.label, FinancialStateLabel::Advice);
}

#[test]
fn test_target_status_assumptions_populated() {
    let status = compute_target_status(
        "tgt_asc",
        "Assumptions",
        &Money::new(100_000, "USD"),
        &Money::new(50_000, "USD"),
        &Money::new(10_000, "USD"),
        5,
        10,
    );
    assert!(!status.assumptions.is_empty());
    assert!(status
        .assumptions
        .iter()
        .any(|a| a.contains("contribution")));
}

#[test]
fn test_target_status_uncertainty_scales() {
    // 5 months remaining (50k/10k) → 5/36 ≈ 0.139
    let status = compute_target_status(
        "tgt_unc",
        "Uncertainty",
        &Money::new(100_000, "USD"),
        &Money::new(50_000, "USD"),
        &Money::new(10_000, "USD"),
        5,
        10,
    );
    let u = status.uncertainty.unwrap();
    assert!(
        (u - 0.139).abs() < 0.01,
        "uncertainty={} expected ~0.139",
        u
    );

    // Completed goal → no uncertainty
    let status2 = compute_target_status(
        "tgt_unc2",
        "Complete",
        &Money::new(100_000, "USD"),
        &Money::new(100_000, "USD"),
        &Money::new(10_000, "USD"),
        10,
        10,
    );
    assert!(status2.uncertainty.is_none());
}

#[test]
fn test_target_status_new_fields_camelcase_json() {
    let status = compute_target_status(
        "tgt_j2",
        "JSON Test",
        &Money::new(100_000, "USD"),
        &Money::new(50_000, "USD"),
        &Money::new(10_000, "USD"),
        5,
        10,
    );
    let json = serde_json::to_string(&status).unwrap();
    assert!(json.contains("label"));
    assert!(json.contains("advice"));
    assert!(json.contains("assumptions"));
    assert!(json.contains("uncertainty"));
}

#[test]
fn test_target_status_new_fields_roundtrip() {
    let status = compute_target_status(
        "tgt_rt2",
        "RT",
        &Money::new(100_000, "USD"),
        &Money::new(50_000, "USD"),
        &Money::new(10_000, "USD"),
        5,
        10,
    );
    let json = serde_json::to_string(&status).unwrap();
    let back: TargetStatus = serde_json::from_str(&json).unwrap();
    assert_eq!(status.label, back.label);
    assert_eq!(status.assumptions, back.assumptions);
    assert_eq!(status.uncertainty, back.uncertainty);
}
