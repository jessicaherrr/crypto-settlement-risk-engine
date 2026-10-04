// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HorizonMetricsTable } from '../HorizonMetricsTable';
import type { RiskSnapshotHorizon } from '@/lib/server/risk-service';

function horizon(overrides: Partial<RiskSnapshotHorizon> = {}): RiskSnapshotHorizon {
  return {
    horizon_days: 7,
    forecast_volatility_annualized: '0.6073843099155843',
    value_at_risk: '0.2501844151337373',
    expected_shortfall: '0.32426102018533715',
    stress_loss: '0.5175822253324002',
    worst_stress_scenario: 'gap_down_shock_50%',
    loss_basis_source: 'stress',
    collateral_ratio: '1.517582225332400200',
    required_collateral_per_unit: '1.517582225332400200',
    stress_scenarios: [],
    ...overrides,
  };
}

describe('HorizonMetricsTable', () => {
  it('renders the exact bigint-safe formatted strings, not float-rounded approximations', () => {
    render(<HorizonMetricsTable horizons={[horizon()]} />);

    expect(screen.getByText('7d')).toBeInTheDocument();
    // VaR 0.2501844151337373 -> 25.02%
    expect(screen.getByText('25.02%')).toBeInTheDocument();
    // ES 0.32426102018533715 -> 32.43%
    expect(screen.getByText('32.43%')).toBeInTheDocument();
    // collateral ratio 1.5175822253324002 -> 1.52x
    expect(screen.getByText('1.52×')).toBeInTheDocument();
  });

  it('shows "Stress" as the binding basis when loss_basis_source is stress', () => {
    render(<HorizonMetricsTable horizons={[horizon({ loss_basis_source: 'stress' })]} />);
    expect(screen.getByText('Stress')).toBeInTheDocument();
  });

  it('shows "Expected Shortfall" as the binding basis when it is the larger basis', () => {
    render(<HorizonMetricsTable horizons={[horizon({ loss_basis_source: 'expected_shortfall' })]} />);
    // "Expected Shortfall" also appears as the column header - the
    // binding-basis badge is the second occurrence.
    const matches = screen.getAllByText('Expected Shortfall');
    expect(matches).toHaveLength(2);
  });

  it('renders one row per horizon, in the order given', () => {
    render(
      <HorizonMetricsTable
        horizons={[horizon({ horizon_days: 1 }), horizon({ horizon_days: 7 }), horizon({ horizon_days: 30 })]}
      />
    );
    const rows = screen.getAllByRole('row');
    // 1 header row + 3 data rows
    expect(rows).toHaveLength(4);
    expect(screen.getByText('1d')).toBeInTheDocument();
    expect(screen.getByText('30d')).toBeInTheDocument();
  });
});
