import { beforeEach, expect, it, vi } from 'vitest';
import { billingApi } from '@/lib/api/billing';
import { apiFetch, apiPost } from '@/lib/api/client';

vi.mock('@/lib/api/client', () => ({ API_BASE: '/api/v1', apiFetch: vi.fn(), apiPost: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it('creates orders with only the server package ID and a stable request key', async () => {
  vi.mocked(apiPost).mockResolvedValue(
    new Response(JSON.stringify({ id: 'order-a', status: 'pending' }))
  );
  const order = await billingApi.createOrder('starter', 'stable-request-key');
  expect(apiPost).toHaveBeenCalledWith('/billing/orders', {
    package_id: 'starter',
    idempotency_key: 'stable-request-key',
  });
  expect(order.status).toBe('pending');
  expect(billingApi.qrUrl('order-a')).toBe('/api/v1/billing/orders/order-a/qr.svg');
});
it('surfaces server errors and uses cursor pagination', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ detail: '账单服务暂不可用' }), { status: 503 })
  );
  await expect(billingApi.ledger(10)).rejects.toThrow('账单服务暂不可用');
  expect(apiFetch).toHaveBeenCalledWith('/billing/ledger?before_id=10');
});
it('encodes server filters for order and ledger pages without changing legacy defaults', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async () => new Response(JSON.stringify({ items: [], next_before_id: null }))
  );
  await billingApi.orders('order-a', { status: 'paid', search: '套餐 A', from: 10, to: 20 });
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/billing/orders?before_id=order-a&status=paid&search=%E5%A5%97%E9%A4%90+A&from=10&to=20'
  );
  await billingApi.ledger(5, { kind: 'spend', from: 0 });
  expect(apiFetch).toHaveBeenLastCalledWith('/billing/ledger?before_id=5&kind=spend&from=0');
  await billingApi.orders();
  expect(apiFetch).toHaveBeenLastCalledWith('/billing/orders');
});
it('returns authenticated CSV downloads and surfaces oversized-export errors', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response('id,kind\n1,spend', { headers: { 'Content-Type': 'text/csv' } })
  );
  const blob = await billingApi.exportLedger({ kind: 'spend' });
  expect(await blob.text()).toBe('id,kind\n1,spend');
  expect(apiFetch).toHaveBeenLastCalledWith('/billing/ledger/export?kind=spend');
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ detail: '请缩小日期范围' }), { status: 413 })
  );
  await expect(billingApi.exportLedger()).rejects.toThrow('请缩小日期范围');
});
