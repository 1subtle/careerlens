'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { Download, RefreshCw, Wallet, X } from 'lucide-react';
import { useAuth } from '@/components/auth/auth-provider';
import { useLanguage } from '@/lib/context/language-context';
import { safeAccountTimeZone } from '@/lib/utils/account-timezone';
import {
  billingApi,
  type BillingSummary,
  type CreditEntry,
  type LedgerFilters,
  type LedgerPage,
  type OrderFilters,
  type OrderPage,
  type PaymentOrder,
} from '@/lib/api/billing';
import s from './billing-panels.module.css';

interface PanelProps {
  locale?: string;
  timeZone?: string;
}
type Copy = (zh: string, en: string) => string;
function usePresentation({ locale, timeZone = 'Asia/Shanghai' }: PanelProps) {
  const { uiLanguage } = useLanguage();
  const chinese = (locale ?? uiLanguage).startsWith('zh');
  const language = chinese ? 'zh-CN' : 'en-US';
  const t = useCallback<Copy>((zh, en) => (chinese ? zh : en), [chinese]);
  return { t, language, timeZone: safeAccountTimeZone(timeZone) };
}
type Presentation = ReturnType<typeof usePresentation>;
const failure = (cause: unknown, t: Copy) =>
  cause instanceof Error
    ? cause.message
    : t('请求未完成，请重试。', 'The request could not be completed. Please try again.');
const price = (amount: number, currency: string, language: string) =>
  new Intl.NumberFormat(language, { style: 'currency', currency }).format(amount / 100);
const dateTime = (value: number, { language, timeZone }: Presentation) =>
  new Intl.DateTimeFormat(language, {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
  }).format(value * 1000);
function useActive() {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return useCallback(() => active.current, []);
}

const kinds = ['spend', 'purchase', 'grant', 'hold', 'release', 'opening', 'adjustment'] as const;
const statuses = ['pending', 'paid', 'created', 'closed'] as const;
function entryLabel(kind: CreditEntry['kind'], t: Copy) {
  return {
    opening: t('期初余额', 'Opening balance'),
    grant: t('注册赠送', 'Signup credit'),
    hold: t('AI 处理中', 'AI reservation'),
    spend: t('AI 消费', 'AI usage'),
    release: t('积分退回', 'Credits returned'),
    purchase: t('微信充值', 'WeChat top-up'),
    adjustment: t('余额调整', 'Balance adjustment'),
  }[kind];
}
function statusLabel(status: PaymentOrder['status'], t: Copy) {
  return {
    created: t('待生成二维码', 'Preparing QR code'),
    pending: t('待支付', 'Awaiting payment'),
    paid: t('已到账', 'Paid'),
    closed: t('已关闭', 'Closed'),
  }[status];
}
function entryChange(entry: CreditEntry, t: Copy) {
  if (entry.kind === 'hold')
    return t(`预留 ${entry.reserved_delta} 积分`, `${entry.reserved_delta} credits reserved`);
  if (entry.kind === 'spend')
    return t(
      `消耗 ${Math.abs(entry.reserved_delta)} 积分`,
      `${Math.abs(entry.reserved_delta)} credits used`
    );
  return `${entry.balance_delta > 0 ? '+' : ''}${entry.balance_delta} ${t('积分', 'credits')}`;
}

// Convert a calendar date in the account's chosen zone, including DST boundaries.
export function billingDateEpoch(date: string, timeZone: string, nextDay = false): number {
  const target = new Date(`${date}T00:00:00Z`);
  if (nextDay) target.setUTCDate(target.getUTCDate() + 1);
  const targetTime = target.getTime();
  let guess = targetTime;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: safeAccountTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(
      formatter.formatToParts(guess).map((part) => [part.type, part.value])
    );
    const displayed = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const delta = targetTime - displayed;
    guess += delta;
    if (!delta) break;
  }
  return guess / 1000;
}
function dateFilters(from: string, to: string, timeZone: string) {
  return {
    ...(from ? { from: billingDateEpoch(from, timeZone) } : {}),
    ...(to ? { to: billingDateEpoch(to, timeZone, true) } : {}),
  };
}
function DateFields({
  from,
  to,
  setFrom,
  setTo,
  t,
}: {
  from: string;
  to: string;
  setFrom: (value: string) => void;
  setTo: (value: string) => void;
  t: Copy;
}) {
  return (
    <>
      <label className={s.field}>
        {t('开始日期', 'From date')}
        <input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => setFrom(e.target.value)}
        />
      </label>
      <label className={s.field}>
        {t('结束日期', 'To date')}
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => setTo(e.target.value)}
        />
      </label>
    </>
  );
}
function ErrorNotice({
  error,
  retry,
  loading,
  t,
}: {
  error: string;
  retry?: () => void;
  loading?: boolean;
  t: Copy;
}) {
  return error ? (
    <div className={s.error} role="alert">
      {error}
      {retry && (
        <button className={s.textButton} disabled={loading} onClick={retry}>
          {t('重新加载账单', 'Retry loading')}
        </button>
      )}
    </div>
  ) : null;
}

function PaymentPanel({
  order,
  onChange,
  onPaid,
  onClose,
  presentation,
}: {
  order: PaymentOrder;
  onChange: (order: PaymentOrder) => void;
  onPaid: () => Promise<void>;
  onClose: () => void;
  presentation: Presentation;
}) {
  const { t, language } = presentation;
  const active = useActive();
  const panel = useRef<HTMLElement | null>(null);
  const [now, setNow] = useState(Date.now);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [qrFailed, setQrFailed] = useState(false);
  const [qrVersion, setQrVersion] = useState(0);
  const inFlight = useRef(false);
  const seconds = Math.max(0, Math.ceil(order.expires_at - now / 1000));
  const pending = order.status === 'created' || order.status === 'pending';
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    try {
      const next = await billingApi.refreshOrder(order.id);
      if (!active()) return;
      onChange(next);
      setError('');
      if (next.status === 'paid') await onPaid();
    } catch (cause) {
      if (active()) setError(failure(cause, t));
    } finally {
      inFlight.current = false;
      if (active()) setChecking(false);
    }
  }, [active, order.id, onChange, onPaid, t]);
  useEffect(() => {
    if (!pending) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const polling = window.setInterval(() => {
      if (!document.hidden && Date.now() < order.expires_at * 1000 && order.status === 'pending')
        void refresh();
    }, 5000);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(polling);
    };
  }, [pending, order.expires_at, order.status, refresh]);
  return (
    <section
      ref={panel}
      tabIndex={-1}
      className={s.paymentPanel}
      aria-label={t('微信支付订单', 'WeChat payment order')}
    >
      <div className={s.sectionHeading}>
        <h2>{order.description}</h2>
        <button
          className={s.iconButton}
          onClick={onClose}
          aria-label={t('关闭订单详情', 'Close order details')}
        >
          <X size={18} />
        </button>
      </div>
      <p className={s.paymentAmount}>
        {price(order.amount_fen, order.currency, language)}
        <span>{t(`充值 ${order.credits} 积分`, `${order.credits} credits`)}</span>
      </p>
      {order.status === 'paid' ? (
        <p className={s.success} role="status">
          {t(
            `支付成功，${order.credits} 积分已到账。`,
            `Payment confirmed. ${order.credits} credits have been added.`
          )}
        </p>
      ) : order.status === 'closed' ? (
        <p className={s.muted}>
          {t(
            '订单已关闭，可重新选择充值套餐。',
            'This order is closed. You can select a package to start again.'
          )}
        </p>
      ) : (
        <>
          {seconds > 0 && order.code_url ? (
            <>
              {!qrFailed && (
                <Image
                  unoptimized
                  key={qrVersion}
                  className={s.paymentQr}
                  src={`${billingApi.qrUrl(order.id)}?v=${qrVersion}`}
                  alt={t('微信付款二维码', 'WeChat payment QR code')}
                  width={224}
                  height={224}
                  onError={() => setQrFailed(true)}
                />
              )}
              {qrFailed ? (
                <p className={s.error} role="alert">
                  {t('二维码加载失败。', 'The QR code could not be loaded.')}
                  <button
                    className={s.textButton}
                    onClick={() => {
                      setQrFailed(false);
                      setQrVersion((v) => v + 1);
                    }}
                  >
                    {t('重新加载二维码', 'Reload QR code')}
                  </button>
                </p>
              ) : (
                <p>{t('使用微信扫一扫支付', 'Scan with WeChat to pay')}</p>
              )}
              <p className={s.muted}>
                {t('二维码有效期', 'QR code expires in')}{' '}
                <span className={s.countdown}>
                  {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
                </span>
              </p>
            </>
          ) : (
            <p className={s.muted}>
              {seconds <= 0
                ? t(
                    '二维码已过期。若已付款，请刷新支付结果；未付款可重新选择套餐。',
                    'The QR code has expired. Refresh the payment status if you have paid, or select a package again.'
                  )
                : t(
                    '订单尚未生成付款二维码，可重新选择套餐创建订单。',
                    'A payment QR code is not available yet. Select a package to try again.'
                  )}
            </p>
          )}
          <button className={s.button} disabled={checking} onClick={() => void refresh()}>
            {checking
              ? t('正在查询支付结果…', 'Checking payment…')
              : t('刷新支付结果', 'Refresh payment status')}
          </button>
          <p className={s.muted}>
            {t('支付后自动查询到账状态。', 'Payment status updates automatically.')}
          </p>
        </>
      )}
      <ErrorNotice error={error} t={t} />
      <p className={s.orderId}>
        {t('订单号：', 'Order ID: ')}
        {order.id}
      </p>
    </section>
  );
}

export function WalletPanel(props: PanelProps = {}) {
  const auth = useAuth();
  const presentation = usePresentation(props);
  return (
    <WalletContent key={`${auth?.session?.user?.id}:${auth?.epoch}`} presentation={presentation} />
  );
}
function WalletContent({ presentation }: { presentation: Presentation }) {
  const auth = useAuth();
  const { t, language } = presentation;
  const userId = auth?.session?.user?.id;
  const refreshSession = auth?.refresh;
  const active = useActive();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [orders, setOrders] = useState<PaymentOrder[]>([]);
  const [selected, setSelected] = useState<PaymentOrder | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState('');
  const [error, setError] = useState('');
  const [paymentError, setPaymentError] = useState('');
  const keys = useRef<Record<string, string>>({});
  const creatingGuard = useRef(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    if (!userId) return;
    const id = ++sequence.current;
    setLoading(true);
    const results = await Promise.allSettled([billingApi.summary(), billingApi.orders()]);
    if (!active() || id !== sequence.current) return;
    if (results[0].status === 'fulfilled') setSummary(results[0].value);
    if (results[1].status === 'fulfilled') {
      const items = results[1].value.items;
      setOrders(items);
      setSelected((current) =>
        current && current.status !== 'paid'
          ? (items.find((item) => item.id === current.id) ?? current)
          : current
      );
    }
    setError(
      results
        .filter((r) => r.status === 'rejected')
        .map((r) => failure(r.reason, t))
        .join(' · ')
    );
    setLoading(false);
  }, [active, userId, t]);
  useEffect(() => {
    void load();
  }, [load, auth?.session?.user?.credits]);
  const updateOrder = useCallback((order: PaymentOrder) => {
    setOrders((items) => [order, ...items.filter((item) => item.id !== order.id)]);
    setSelected((current) => (current?.id === order.id ? order : current));
  }, []);
  const paid = useCallback(async () => {
    if (active()) await Promise.all([load(), refreshSession?.()]);
  }, [active, load, refreshSession]);
  async function create(packageId: string) {
    if (creatingGuard.current) return;
    const existing = orders.find(
      (order) =>
        order.package_id === packageId &&
        order.status === 'pending' &&
        order.code_url &&
        order.expires_at * 1000 > Date.now()
    );
    if (existing) {
      setSelected(existing);
      setPaymentError('');
      return;
    }
    creatingGuard.current = true;
    setCreating(packageId);
    setPaymentError('');
    keys.current[packageId] ??= crypto.randomUUID();
    try {
      const order = await billingApi.createOrder(packageId, keys.current[packageId]);
      if (!active()) return;
      delete keys.current[packageId];
      updateOrder(order);
      setSelected(order);
      if (order.status === 'paid') await paid();
    } catch (cause) {
      if (active())
        setPaymentError(
          `${failure(cause, t)} ${t('请再次选择同一套餐重试。', 'Select the same package to retry.')}`
        );
    } finally {
      creatingGuard.current = false;
      if (active()) setCreating('');
    }
  }
  return (
    <div className={s.page}>
      <div className={s.metrics} aria-busy={loading}>
        <div className={`${s.metric} ${s.balance}`}>
          <div className={s.metricHeading}>
            <span>{t('可用积分', 'Available credits')}</span>
            <button
              className={s.refreshBalance}
              disabled={loading}
              onClick={() => void load()}
              aria-label={loading ? t('正在加载…', 'Loading…') : t('刷新账单', 'Refresh balance')}
              title={t('刷新账单', 'Refresh balance')}
            >
              <RefreshCw size={16} aria-hidden="true" />
            </button>
          </div>
          <strong
            role="status"
            aria-label={t(
              `剩余 ${summary?.balance ?? auth?.session?.user?.credits ?? '—'} 积分`,
              `${summary?.balance ?? auth?.session?.user?.credits ?? '—'} available credits`
            )}
          >
            {summary?.balance ?? auth?.session?.user?.credits ?? '—'}
          </strong>
          <small>{t('可用于 AI 生成', 'Ready for AI generations')}</small>
        </div>
        <div className={s.metric}>
          <span>{t('处理中预留', 'Reserved credits')}</span>
          <strong>{summary?.reserved ?? '—'}</strong>
          <small>{t('完成后结算，失败后退回', 'Settled on success, returned on failure')}</small>
        </div>
        <div className={s.metric}>
          <span>{t('累计消费积分', 'Total credits used')}</span>
          <strong>{summary?.total_spent ?? '—'}</strong>
          <small>{t('自流水记录启用起', 'Since usage tracking began')}</small>
        </div>
        <div className={s.metric}>
          <span>{t('累计充值积分', 'Total credits purchased')}</span>
          <strong>{summary?.total_purchased ?? '—'}</strong>
          <small>
            {summary?.total_paid_fen === undefined
              ? t('仅统计已到账订单', 'Paid orders only')
              : t(
                  `实付 ${price(summary.total_paid_fen, 'CNY', language)}`,
                  `${price(summary.total_paid_fen, 'CNY', language)} paid`
                )}
          </small>
        </div>
      </div>
      <ErrorNotice error={error} retry={() => void load()} loading={loading} t={t} />
      <section className={s.card} aria-labelledby="wallet-topup">
        <div className={s.sectionHeading}>
          <h2 id="wallet-topup">{t('积分充值', 'Top up credits')}</h2>
          {summary?.payment_enabled && !!summary.packages.length && (
            <span className={s.tag}>{t('微信支付', 'WeChat Pay')}</span>
          )}
        </div>
        {!summary ? (
          <p className={s.muted}>
            {loading
              ? t('正在加载充值信息…', 'Loading packages…')
              : t(
                  '充值信息暂不可用，请重新加载账单。',
                  'Packages could not be loaded. Please retry.'
                )}
          </p>
        ) : !summary.payment_enabled || !summary.packages.length ? (
          <div className={s.emptyRecharge}>
            <Wallet size={30} aria-hidden="true" />
            <h3>{t('充值暂未开放', 'Top-ups are not available yet')}</h3>
            <p>
              {t(
                '充值暂未开放。已有积分仍可正常使用。',
                'You can continue using your existing credits.'
              )}
            </p>
          </div>
        ) : (
          <div className={s.packages}>
            {summary.packages.map((item) => (
              <button
                key={item.id}
                className={s.packageButton}
                disabled={!!creating || loading}
                onClick={() => void create(item.id)}
              >
                <span>{item.name}</span>
                <strong>
                  {item.credits} <small>{t('积分', 'credits')}</small>
                </strong>
                <span className={s.packagePrice}>
                  {price(item.amount_fen, item.currency, language)}
                </span>
                <span className={s.packageAction}>
                  {creating === item.id
                    ? t('正在创建订单…', 'Creating order…')
                    : t('微信支付', 'Pay with WeChat')}
                </span>
              </button>
            ))}
          </div>
        )}
        <ErrorNotice error={paymentError} t={t} />
      </section>
      {selected && (
        <PaymentPanel
          key={selected.id}
          order={selected}
          onChange={updateOrder}
          onPaid={paid}
          onClose={() => setSelected(null)}
          presentation={presentation}
        />
      )}
      <section className={s.usageNote}>
        <h2>{t('积分如何使用', 'How credits work')}</h2>
        <p>
          {t(
            '每次成功结算的 AI 生成消耗 1 积分，一个操作可能包含多次生成。未完成的请求会释放预留积分。',
            'Each successfully settled AI generation uses 1 credit. An action may include several generations. Unfinished requests release their reserved credits.'
          )}
        </p>
        <p>
          {t(
            '编辑、保存和导出简历不消耗 AI 积分。',
            'Editing, saving and exporting resumes do not use AI credits.'
          )}
        </p>
      </section>
    </div>
  );
}

export function OrdersPanel(props: PanelProps = {}) {
  const auth = useAuth();
  const presentation = usePresentation(props);
  return (
    <OrdersContent key={`${auth?.session?.user?.id}:${auth?.epoch}`} presentation={presentation} />
  );
}
function OrdersContent({ presentation }: { presentation: Presentation }) {
  const auth = useAuth();
  const { t, timeZone, language } = presentation;
  const active = useActive();
  const [page, setPage] = useState<OrderPage>({ items: [], next_before_id: null });
  const [filters, setFilters] = useState<OrderFilters>({});
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<PaymentOrder | null>(null);
  const sequence = useRef(0);
  const load = useCallback(
    async (before?: string) => {
      if (!auth?.session?.user?.id) return;
      const id = ++sequence.current;
      setLoading(true);
      try {
        const next = await billingApi.orders(before, filters);
        if (!active() || id !== sequence.current) return;
        setPage((previous) => ({
          ...next,
          items: before
            ? [
                ...previous.items,
                ...next.items.filter((item) => !previous.items.some((old) => old.id === item.id)),
              ]
            : next.items,
        }));
        setSelected((current) =>
          current && current.status !== 'paid'
            ? (next.items.find((item) => item.id === current.id) ?? current)
            : current
        );
        setError('');
      } catch (cause) {
        if (active() && id === sequence.current) setError(failure(cause, t));
      } finally {
        if (active() && id === sequence.current) setLoading(false);
      }
    },
    [active, auth?.session?.user?.id, filters, t]
  );
  useEffect(() => {
    setPage({ items: [], next_before_id: null });
    void load();
  }, [load]);
  const updateOrder = useCallback((order: PaymentOrder) => {
    setSelected((current) => (current?.id === order.id ? order : current));
    setPage((previous) => ({
      ...previous,
      items: previous.items.map((item) => (item.id === order.id ? order : item)),
    }));
  }, []);
  const refreshSession = auth?.refresh;
  const paid = useCallback(async () => {
    if (active()) await Promise.all([load(), refreshSession?.()]);
  }, [active, load, refreshSession]);
  return (
    <div className={s.page}>
      <section className={s.card}>
        <form
          className={s.filters}
          onSubmit={(e) => {
            e.preventDefault();
            setFilters({
              ...dateFilters(from, to, timeZone),
              ...(status ? { status: status as PaymentOrder['status'] } : {}),
              ...(search.trim() ? { search: search.trim() } : {}),
            });
          }}
        >
          <label className={`${s.field} ${s.searchField}`}>
            {t('搜索订单', 'Search orders')}
            <input
              value={search}
              maxLength={100}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('订单号或套餐名称', 'Order ID or package name')}
            />
          </label>
          <label className={s.field}>
            {t('订单状态', 'Order status')}
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('全部状态', 'All statuses')}</option>
              {statuses.map((value) => (
                <option key={value} value={value}>
                  {statusLabel(value, t)}
                </option>
              ))}
            </select>
          </label>
          <DateFields from={from} to={to} setFrom={setFrom} setTo={setTo} t={t} />
          <button className={`${s.button} ${s.primary}`} disabled={loading}>
            {t('筛选', 'Apply filters')}
          </button>
          <button
            className={s.textButton}
            type="button"
            disabled={loading}
            onClick={() => {
              setStatus('');
              setSearch('');
              setFrom('');
              setTo('');
              setFilters({});
            }}
          >
            {t('重置', 'Reset')}
          </button>
          <button className={s.button} type="button" disabled={loading} onClick={() => void load()}>
            <RefreshCw size={16} aria-hidden="true" />
            {t('刷新订单', 'Refresh orders')}
          </button>
        </form>
        <p className={s.filterNote}>
          {t(`日期与时间按 ${timeZone} 显示。`, `Dates and times use ${timeZone}.`)}
        </p>
        <ErrorNotice error={error} retry={() => void load()} loading={loading} t={t} />
        <div className={s.tableWrap} aria-busy={loading}>
          <table className={s.table}>
            <thead>
              <tr>
                {[
                  t('订单', 'Order'),
                  t('创建时间', 'Created'),
                  t('金额', 'Amount'),
                  t('积分', 'Credits'),
                  t('状态', 'Status'),
                  t('操作', 'Action'),
                ].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.items.map((order) => (
                <tr key={order.id}>
                  <td>
                    <strong>{order.description}</strong>
                    <small className={s.identifier}>{order.id}</small>
                  </td>
                  <td>{dateTime(order.created_at, presentation)}</td>
                  <td>{price(order.amount_fen, order.currency, language)}</td>
                  <td>{order.credits}</td>
                  <td>
                    <span className={s.status} data-status={order.status}>
                      {statusLabel(order.status, t)}
                    </span>
                  </td>
                  <td>
                    <button className={s.textButton} onClick={() => setSelected(order)}>
                      {order.status === 'pending'
                        ? t('继续支付', 'Continue payment')
                        : t('查看订单', 'View order')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!page.items.length && (
            <p className={s.empty}>
              {loading
                ? t('正在加载订单…', 'Loading orders…')
                : t('暂无符合条件的订单。', 'No orders match these filters.')}
            </p>
          )}
        </div>
        {page.next_before_id && (
          <div className={s.pagination}>
            <button
              className={s.button}
              disabled={loading}
              onClick={() => void load(page.next_before_id ?? undefined)}
            >
              {loading ? t('正在加载…', 'Loading…') : t('加载更早订单', 'Load older orders')}
            </button>
          </div>
        )}
      </section>
      {selected && (
        <PaymentPanel
          key={selected.id}
          order={selected}
          onChange={updateOrder}
          onPaid={paid}
          onClose={() => setSelected(null)}
          presentation={presentation}
        />
      )}
    </div>
  );
}

export function UsagePanel(props: PanelProps = {}) {
  const auth = useAuth();
  const presentation = usePresentation(props);
  return (
    <UsageContent key={`${auth?.session?.user?.id}:${auth?.epoch}`} presentation={presentation} />
  );
}
function UsageContent({ presentation }: { presentation: Presentation }) {
  const auth = useAuth();
  const { t, timeZone } = presentation;
  const active = useActive();
  const [page, setPage] = useState<LedgerPage>({ items: [], next_before_id: null });
  const [filters, setFilters] = useState<LedgerFilters>({});
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const load = useCallback(
    async (before?: number) => {
      if (!auth?.session?.user?.id) return;
      const id = ++sequence.current;
      setLoading(true);
      try {
        const next = await billingApi.ledger(before, filters);
        if (!active() || id !== sequence.current) return;
        setPage((previous) => ({
          ...next,
          items: before
            ? [
                ...previous.items,
                ...next.items.filter((item) => !previous.items.some((old) => old.id === item.id)),
              ]
            : next.items,
        }));
        setError('');
      } catch (cause) {
        if (active() && id === sequence.current) setError(failure(cause, t));
      } finally {
        if (active() && id === sequence.current) setLoading(false);
      }
    },
    [active, auth?.session?.user?.id, filters, t]
  );
  useEffect(() => {
    setPage({ items: [], next_before_id: null });
    void load();
  }, [load, auth?.session?.user?.credits]);
  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    try {
      const blob = await billingApi.exportLedger(filters);
      if (!active()) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'CareerLens-credit-usage.csv';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError('');
    } catch (cause) {
      if (active()) setError(failure(cause, t));
    } finally {
      if (active()) setExporting(false);
    }
  }
  return (
    <div className={s.page}>
      <section className={s.card}>
        <form
          className={s.filters}
          onSubmit={(e) => {
            e.preventDefault();
            setFilters({
              ...dateFilters(from, to, timeZone),
              ...(kind ? { kind: kind as CreditEntry['kind'] } : {}),
            });
          }}
        >
          <label className={s.field}>
            {t('记录类型', 'Activity type')}
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">{t('全部类型', 'All types')}</option>
              {kinds.map((value) => (
                <option key={value} value={value}>
                  {entryLabel(value, t)}
                </option>
              ))}
            </select>
          </label>
          <DateFields from={from} to={to} setFrom={setFrom} setTo={setTo} t={t} />
          <button className={`${s.button} ${s.primary}`} disabled={loading}>
            {t('筛选', 'Apply filters')}
          </button>
          <button
            className={s.textButton}
            type="button"
            disabled={loading}
            onClick={() => {
              setKind('');
              setFrom('');
              setTo('');
              setFilters({});
            }}
          >
            {t('重置', 'Reset')}
          </button>
          <button
            className={s.button}
            type="button"
            disabled={loading || exporting}
            onClick={() => void exportCsv()}
          >
            <Download size={16} aria-hidden="true" />
            {exporting
              ? t('正在导出…', 'Exporting…')
              : t('导出筛选结果', 'Export filtered results')}
          </button>
        </form>
        <p className={s.filterNote}>
          {t(
            `页面时间按 ${timeZone} 显示；CSV 时间为 UTC，最多导出 10,000 条。`,
            `Times use ${timeZone}; CSV timestamps use UTC. Up to 10,000 matching rows per export.`
          )}
        </p>
        <ErrorNotice error={error} retry={() => void load()} loading={loading} t={t} />
        <div className={s.tableWrap} aria-busy={loading}>
          <table className={s.table}>
            <thead>
              <tr>
                {[
                  t('类型', 'Type'),
                  t('时间', 'Time'),
                  t('变动', 'Change'),
                  t('可用余额', 'Available balance'),
                  t('预留余额', 'Reserved balance'),
                ].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.items.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <strong>{entryLabel(entry.kind, t)}</strong>
                    <small className={s.identifier}>#{entry.id}</small>
                  </td>
                  <td>{dateTime(entry.created_at, presentation)}</td>
                  <td className={entry.balance_delta > 0 ? s.positive : undefined}>
                    {entryChange(entry, t)}
                  </td>
                  <td>{entry.balance_after}</td>
                  <td>{entry.reserved_after}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!page.items.length && (
            <p className={s.empty}>
              {loading
                ? t('正在加载流水…', 'Loading activity…')
                : t('暂无符合条件的积分记录。', 'No credit activity matches these filters.')}
            </p>
          )}
        </div>
        {page.next_before_id !== null && (
          <div className={s.pagination}>
            <button
              className={s.button}
              disabled={loading}
              onClick={() => void load(page.next_before_id ?? undefined)}
            >
              {loading ? t('正在加载…', 'Loading…') : t('加载更早流水', 'Load older activity')}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
