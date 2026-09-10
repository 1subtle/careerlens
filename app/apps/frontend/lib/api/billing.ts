import { API_BASE, apiFetch, apiPost } from './client';

export interface CreditPackage {
  id: string;
  name: string;
  credits: number;
  amount_fen: number;
  currency: string;
}

export interface BillingSummary {
  balance: number;
  signup_grant: number;
  reserved: number;
  cost_per_generation: number;
  payment_enabled: boolean;
  packages: CreditPackage[];
  total_spent?: number;
  total_purchased?: number;
  total_paid_fen?: number;
}

export interface CreditEntry {
  id: number;
  kind: 'opening' | 'grant' | 'hold' | 'spend' | 'release' | 'purchase' | 'adjustment';
  operation_id: string | null;
  generation_id: string | null;
  order_id: string | null;
  balance_delta: number;
  reserved_delta: number;
  balance_after: number;
  reserved_after: number;
  created_at: number;
}

export interface LedgerPage {
  items: CreditEntry[];
  next_before_id: number | null;
}

export interface PaymentOrder {
  id: string;
  package_id: string;
  description: string;
  amount_fen: number;
  currency: string;
  credits: number;
  status: 'created' | 'pending' | 'paid' | 'closed';
  code_url: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  paid_at: number | null;
}

export interface BillingFilters {
  from?: number;
  to?: number;
}
export interface LedgerFilters extends BillingFilters {
  kind?: CreditEntry['kind'];
}
export interface OrderFilters extends BillingFilters {
  status?: PaymentOrder['status'];
  search?: string;
}
export interface OrderPage {
  items: PaymentOrder[];
  next_before_id?: string | null;
}

function query(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== '') params.set(key, String(value));
  return params.size ? `?${params}` : '';
}

async function result<T>(request: Promise<Response>): Promise<T> {
  const response = await request;
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(typeof body?.detail === 'string' ? body.detail : '账单请求未完成，请重试。');
  return body as T;
}

export const billingApi = {
  summary: () => result<BillingSummary>(apiFetch('/billing/summary')),
  ledger: (beforeId?: number, filters: LedgerFilters = {}) =>
    result<LedgerPage>(apiFetch(`/billing/ledger${query({ before_id: beforeId, ...filters })}`)),
  orders: (beforeId?: string, filters: OrderFilters = {}) =>
    result<OrderPage>(apiFetch(`/billing/orders${query({ before_id: beforeId, ...filters })}`)),
  exportLedger: async (filters: LedgerFilters = {}) => {
    const response = await apiFetch(`/billing/ledger/export${query({ ...filters })}`);
    if (!response.ok) await result(Promise.resolve(response));
    return response.blob();
  },
  createOrder: (packageId: string, idempotencyKey: string) =>
    result<PaymentOrder>(
      apiPost('/billing/orders', { package_id: packageId, idempotency_key: idempotencyKey })
    ),
  refreshOrder: (orderId: string) =>
    result<PaymentOrder>(apiPost(`/billing/orders/${encodeURIComponent(orderId)}/refresh`, {})),
  qrUrl: (orderId: string) => `${API_BASE}/billing/orders/${encodeURIComponent(orderId)}/qr.svg`,
};
