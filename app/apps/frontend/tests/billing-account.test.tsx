import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WalletPanel,
  OrdersPanel,
  UsagePanel,
  billingDateEpoch,
} from '@/components/account/billing-panels';
import type { BillingSummary, CreditEntry, PaymentOrder } from '@/lib/api/billing';

const api = vi.hoisted(() => ({
  summary: vi.fn(),
  ledger: vi.fn(),
  orders: vi.fn(),
  createOrder: vi.fn(),
  refreshOrder: vi.fn(),
  qrUrl: vi.fn((id: string) => `/api/v1/billing/orders/${id}/qr.svg`),
  exportLedger: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  session: { user: { id: 'account-a', email: 'account@example.test', credits: 20 } },
  refresh: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('@/lib/api/billing', () => ({ billingApi: api }));
vi.mock('@/components/auth/auth-provider', () => ({ useAuth: () => auth }));
vi.mock('@/lib/context/language-context', () => ({ useLanguage: () => ({ uiLanguage: 'zh' }) }));
vi.mock('@/components/auth/public-site', () => ({
  PublicHeader: () => <header>CareerLens</header>,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));

const summary: BillingSummary = {
  balance: 20,
  reserved: 1,
  signup_grant: 20,
  cost_per_generation: 1,
  payment_enabled: true,
  packages: [{ id: 'starter', name: '体验套餐', credits: 60, amount_fen: 990, currency: 'CNY' }],
  total_spent: 12,
  total_purchased: 60,
  total_paid_fen: 990,
};
function pending(): PaymentOrder {
  return {
    id: 'order-a',
    package_id: 'starter',
    description: 'CareerLens 体验套餐',
    amount_fen: 990,
    currency: 'CNY',
    credits: 60,
    status: 'pending',
    code_url: 'weixin://wxpay/bizpayurl?test',
    created_at: Date.now() / 1000,
    updated_at: Date.now() / 1000,
    expires_at: Date.now() / 1000 + 1800,
    paid_at: null,
  };
}
const entry: CreditEntry = {
  id: 10,
  kind: 'grant',
  operation_id: null,
  generation_id: null,
  order_id: null,
  balance_delta: 20,
  reserved_delta: 0,
  balance_after: 20,
  reserved_after: 0,
  created_at: 1800000000,
};
beforeEach(() => {
  vi.clearAllMocks();
  auth.session.user.id = 'account-a';
  api.summary.mockResolvedValue(summary);
  api.ledger.mockResolvedValue({ items: [entry], next_before_id: null });
  api.orders.mockResolvedValue({ items: [] });
  api.createOrder.mockImplementation(async () => pending());
  api.refreshOrder.mockImplementation(async () => pending());
  auth.refresh.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

async function startPayment() {
  render(<WalletPanel />);
  fireEvent.click(await screen.findByRole('button', { name: /体验套餐/ }));
  return screen.findByRole('img', { name: '微信付款二维码' });
}

describe('account billing', () => {
  it('shows server wallet totals and keeps orders and usage on their own pages', async () => {
    api.summary.mockResolvedValue({ ...summary, balance: 7, payment_enabled: false, packages: [] });
    render(<WalletPanel />);
    expect(await screen.findByText('充值暂未开放。已有积分仍可正常使用。')).toBeVisible();
    expect(screen.getByRole('status', { name: '剩余 7 积分' })).toBeVisible();
    expect(screen.getByText('12')).toBeVisible();
    expect(screen.queryByText('注册赠送')).not.toBeInTheDocument();
    expect(api.ledger).not.toHaveBeenCalled();
    expect(screen.queryByText(/事实核验|多积分|真实性审核/)).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '微信付款二维码' })).not.toBeInTheDocument();
    expect(api.createOrder).not.toHaveBeenCalled();
  });

  it('uses the configured price and only shows paid after the server confirms it', async () => {
    const qr = await startPayment();
    expect(qr).toHaveAttribute(
      'src',
      expect.stringMatching(/\/api\/v1\/billing\/orders\/order-a\/qr\.svg\?v=0$/)
    );
    expect(screen.getAllByText('¥9.90').length).toBeGreaterThan(0);
    expect(api.createOrder).toHaveBeenCalledWith('starter', expect.any(String));
    fireEvent.click(screen.getByRole('button', { name: '刷新支付结果' }));
    await screen.findByRole('button', { name: '刷新支付结果' });
    expect(screen.queryByText(/支付成功/)).not.toBeInTheDocument();
    expect(auth.refresh).not.toHaveBeenCalled();
    api.refreshOrder.mockResolvedValue({
      ...pending(),
      status: 'paid',
      code_url: null,
      paid_at: Date.now() / 1000,
    });
    api.summary.mockResolvedValue({ ...summary, balance: 80 });
    fireEvent.click(screen.getByRole('button', { name: '刷新支付结果' }));
    expect(await screen.findByText('支付成功，60 积分已到账。')).toBeVisible();
    expect(await screen.findByRole('status', { name: '剩余 80 积分' })).toBeVisible();
    expect(auth.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole('img', { name: '微信付款二维码' })).not.toBeInTheDocument();
  });

  it('reuses the idempotency key when order creation has an uncertain failure', async () => {
    api.createOrder.mockRejectedValueOnce(new Error('连接中断'));
    render(<WalletPanel />);
    const button = await screen.findByRole('button', { name: /体验套餐/ });
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('连接中断');
    const key = api.createOrder.mock.calls[0][1];
    fireEvent.click(button);
    await screen.findByRole('img', { name: '微信付款二维码' });
    expect(api.createOrder.mock.calls[1]).toEqual(['starter', key]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reopens an existing pending order and can retry loading its QR image', async () => {
    api.orders.mockResolvedValue({ items: [pending()] });
    render(<OrdersPanel />);
    fireEvent.click(await screen.findByRole('button', { name: '继续支付' }));
    const qr = screen.getByRole('img', { name: '微信付款二维码' });
    fireEvent.error(qr);
    expect(screen.getByRole('alert')).toHaveTextContent('二维码加载失败');
    fireEvent.click(screen.getByRole('button', { name: '重新加载二维码' }));
    expect(screen.getByRole('img', { name: '微信付款二维码' })).toHaveAttribute(
      'src',
      expect.stringMatching(/\/api\/v1\/billing\/orders\/order-a\/qr\.svg\?v=1$/)
    );
    expect(api.createOrder).not.toHaveBeenCalled();
  });

  it('loads older ledger entries without replacing current history', async () => {
    api.ledger.mockResolvedValueOnce({ items: [entry], next_before_id: 10 }).mockResolvedValue({
      items: [{ ...entry, id: 9, kind: 'spend', balance_delta: 0, reserved_delta: -1 }],
      next_before_id: null,
    });
    render(<UsagePanel />);
    fireEvent.click(await screen.findByRole('button', { name: '加载更早流水' }));
    expect(await screen.findByRole('cell', { name: /AI 消费/ })).toBeVisible();
    expect(screen.getByRole('cell', { name: /注册赠送/ })).toBeVisible();
    expect(screen.getByText('消耗 1 积分')).toBeVisible();
    expect(api.ledger).toHaveBeenLastCalledWith(10, {});
    expect(screen.queryByRole('button', { name: '加载更早流水' })).not.toBeInTheDocument();
  });

  it('offers retry after a billing load error and keeps pricing unavailable until loaded', async () => {
    api.summary.mockRejectedValueOnce(new Error('账单服务暂不可用'));
    render(<WalletPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('账单服务暂不可用');
    expect(screen.queryByRole('button', { name: /体验套餐/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新加载账单' }));
    expect(await screen.findByRole('button', { name: /体验套餐/ })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('polls pending orders and expires the QR without asserting payment success', async () => {
    vi.useFakeTimers();
    const order = { ...pending(), expires_at: Date.now() / 1000 + 7 };
    api.orders.mockResolvedValue({ items: [order] });
    api.refreshOrder.mockResolvedValue(order);
    render(<OrdersPanel />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '继续支付' }));
    expect(screen.getByText('0:07')).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(api.refreshOrder).toHaveBeenCalledOnce();
    expect(screen.getByText('0:02')).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText(/二维码已过期/)).toBeVisible();
    expect(screen.queryByRole('img', { name: '微信付款二维码' })).not.toBeInTheDocument();
    expect(screen.queryByText(/支付成功/)).not.toBeInTheDocument();
    expect(auth.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '刷新支付结果' })).toBeEnabled();
  });

  it('reuses an existing pending order when the wallet package is selected', async () => {
    api.orders.mockResolvedValue({ items: [pending()] });
    render(<WalletPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /体验套餐/ }));
    expect(await screen.findByRole('img', { name: '微信付款二维码' })).toBeVisible();
    expect(api.createOrder).not.toHaveBeenCalled();
  });

  it('passes status, search and timezone dates to server pagination', async () => {
    api.orders.mockResolvedValue({ items: [pending()], next_before_id: 'order-a' });
    render(<OrdersPanel timeZone="Asia/Shanghai" />);
    await screen.findByRole('button', { name: '继续支付' });
    fireEvent.change(screen.getByLabelText('订单状态'), { target: { value: 'pending' } });
    fireEvent.change(screen.getByLabelText('搜索订单'), { target: { value: '体验' } });
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-09-10' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-09-10' } });
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    const filters = {
      status: 'pending',
      search: '体验',
      from: Date.parse('2026-09-09T16:00:00Z') / 1000,
      to: Date.parse('2026-09-10T16:00:00Z') / 1000,
    };
    await waitFor(() => expect(api.orders).toHaveBeenLastCalledWith(undefined, filters));
    fireEvent.click(await screen.findByRole('button', { name: '加载更早订单' }));
    await waitFor(() => expect(api.orders).toHaveBeenLastCalledWith('order-a', filters));
    expect(screen.queryByRole('button', { name: /体验套餐/ })).not.toBeInTheDocument();
  });

  it('exports the applied server filter, including records beyond the displayed page', async () => {
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createUrl = vi.fn(() => 'blob:billing-test');
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() })
    );
    api.exportLedger.mockResolvedValue(new Blob(['all filtered rows']));
    render(<UsagePanel />);
    await screen.findByRole('cell', { name: /注册赠送/ });
    fireEvent.change(screen.getByLabelText('记录类型'), { target: { value: 'spend' } });
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    await waitFor(() => expect(api.ledger).toHaveBeenLastCalledWith(undefined, { kind: 'spend' }));
    fireEvent.click(screen.getByRole('button', { name: '导出筛选结果' }));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(api.exportLedger).toHaveBeenCalledWith({ kind: 'spend' });
    expect(createUrl).toHaveBeenCalledWith(expect.any(Blob));
    download.mockRestore();
    vi.unstubAllGlobals();
  });

  it('clears private wallet state on account change and discards the old pending response', async () => {
    let resolve: (value: BillingSummary) => void = () => {};
    api.summary.mockImplementationOnce(
      () =>
        new Promise<BillingSummary>((done) => {
          resolve = done;
        })
    );
    const view = render(<WalletPanel />);
    auth.session.user.id = 'account-b';
    api.summary.mockResolvedValue({ ...summary, balance: 3, payment_enabled: false, packages: [] });
    view.rerender(<WalletPanel />);
    expect(await screen.findByRole('status', { name: '剩余 3 积分' })).toBeVisible();
    await act(async () => {
      resolve({ ...summary, balance: 999 });
    });
    expect(screen.queryByText('999')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /体验套餐/ })).not.toBeInTheDocument();
  });

  it('does not poll while the document is hidden and supports English labels', async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    api.orders.mockResolvedValue({ items: [pending()] });
    render(<OrdersPanel locale="en" timeZone="UTC" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Continue payment' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(api.refreshOrder).not.toHaveBeenCalled();
    expect(screen.getByRole('img', { name: 'WeChat payment QR code' })).toBeVisible();
    hidden.mockReturnValue(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(api.refreshOrder).toHaveBeenCalledOnce();
    hidden.mockRestore();
  });

  it('includes the full selected calendar day across daylight saving transitions', () => {
    const start = billingDateEpoch('2026-03-08', 'America/New_York');
    const end = billingDateEpoch('2026-03-08', 'America/New_York', true);
    expect(new Date(start * 1000).toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(end - start).toBe(23 * 3600);
    expect(
      billingDateEpoch('2026-11-01', 'America/New_York', true) -
        billingDateEpoch('2026-11-01', 'America/New_York')
    ).toBe(25 * 3600);
  });

  it('falls back for backend timezones unsupported by browser Intl in display and filters', async () => {
    render(<UsagePanel timeZone="Factory" />);
    expect(await screen.findByRole('cell', { name: /注册赠送/ })).toBeVisible();
    expect(screen.getByText(/页面时间按 Asia\/Shanghai/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-09-10' } });
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    await waitFor(() =>
      expect(api.ledger).toHaveBeenLastCalledWith(undefined, {
        from: Date.parse('2026-09-09T16:00:00Z') / 1000,
      })
    );
    expect(billingDateEpoch('2026-09-10', 'Factory')).toBe(
      Date.parse('2026-09-09T16:00:00Z') / 1000
    );
  });
});
