'use client';

import { useCareerText } from '@/lib/i18n/career';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { EChartsOption } from 'echarts';
import type { MarketSummary } from '@/lib/api/career';
import s from './workspace.module.css';

const chartColors = { accent: '#7353dc', ink: '#292237', muted: '#675e73', soft: '#f0eafd' };

function Chart({ option, label }: { option: EChartsOption; label: string }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    const setup = async () => {
      const echarts = await import('echarts');
      await import('echarts-wordcloud');
      if (disposed || !element.current) return;
      const chart = echarts.init(element.current);
      chart.setOption({
        animation: false,
        aria: { enabled: true },
        textStyle: {
          color: chartColors.muted,
          fontFamily: window.getComputedStyle(element.current).fontFamily,
        },
        ...option,
      });
      const observer = new ResizeObserver(() => chart.resize());
      observer.observe(element.current);
      cleanup = () => {
        observer.disconnect();
        chart.dispose();
      };
    };
    void setup();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [option]);
  return <div ref={element} className={s.chart} role="img" aria-label={label} />;
}

const units: Record<string, string> = { day: '日', month: '月', year: '年' };
export default function MarketCharts({ summary }: { summary: MarketSummary }) {
  const tr = useCareerText();
  const groups = [...new Set(summary.salaries.map((row) => `${row.currency}/${row.period}`))];
  const [selectedGroup, setSelectedGroup] = useState('');
  const group = useMemo(() => {
    const available = summary.salaries.map((row) => `${row.currency}/${row.period}`);
    return available.includes(selectedGroup) ? selectedGroup : (available[0] ?? '');
  }, [summary, selectedGroup]);
  const wordOption = useMemo(
    () =>
      ({
        tooltip: { renderMode: 'richText' },
        series: [
          {
            type: 'wordCloud',
            shape: 'square',
            rotationRange: [0, 0],
            sizeRange: [16, 58],
            gridSize: 12,
            width: '96%',
            height: '90%',
            textStyle: { color: chartColors.accent },
            data: summary.skills,
          },
        ],
      }) as unknown as EChartsOption,
    [summary]
  );
  const salaryOption = useMemo<EChartsOption>(() => {
    const rows = summary.salaries.filter((row) => `${row.currency}/${row.period}` === group);
    const categories = [...new Set(rows.map((row) => row.category))];
    return {
      tooltip: { trigger: 'item', renderMode: 'richText' },
      grid: { left: 72, right: 24, bottom: 44, top: 36 },
      xAxis: { type: 'category', data: categories },
      yAxis: {
        type: 'value',
        name: group
          ? `${group.split('/')[0]} / ${tr(units[group.split('/')[1]] || group.split('/')[1])}`
          : '',
      },
      series: [
        {
          type: 'scatter',
          symbol: 'circle',
          symbolSize: 12,
          itemStyle: { color: chartColors.accent },
          data: rows.map((row) => ({
            name: tr('{0}\n披露：{1}\n区间中点', row.title, row.raw),
            value: [categories.indexOf(row.category), row.mid],
          })),
        },
      ],
    };
  }, [summary, group, tr]);
  const skillOption = useMemo<EChartsOption>(() => {
    const skills = summary.skills.slice(0, 8).map((row) => row.name);
    return {
      tooltip: { renderMode: 'richText' },
      grid: { left: 88, right: 20, top: 12, bottom: 100 },
      xAxis: { type: 'category', data: skills, axisLabel: { rotate: 30 } },
      yAxis: {
        type: 'category',
        data: summary.distribution.map((row) => `${row.category}\n(n=${row.count})`),
      },
      visualMap: {
        min: 0,
        max: 100,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        inRange: { color: [chartColors.soft, chartColors.accent] },
        text: ['100%', '0%'],
      },
      series: [
        {
          type: 'heatmap',
          label: {
            show: true,
            color: chartColors.ink,
            backgroundColor: 'rgba(255, 255, 255, 0.94)',
            borderRadius: 3,
            padding: [2, 4],
            formatter: (params) => `${(params.value as number[])[2]}%`,
          },
          data: summary.distribution.flatMap((category, y) =>
            skills.map((name, x) => {
              const skill = category.skills.find((row) => row.name === name);
              return {
                name: tr(
                  '{0} · {1}\n{2} / {3} 个岗位',
                  category.category,
                  name,
                  skill?.count ?? 0,
                  category.count
                ),
                value: [x, y, skill?.percent ?? 0],
              };
            })
          ),
        },
      ],
    };
  }, [summary, tr]);
  return (
    <div className={s.charts}>
      <figure className={s.chartFigure}>
        <h3>{tr('热门技能词云')}</h3>
        <figcaption>{tr('字号表示包含该技能的岗位数量，每个岗位对同一技能只计一次。')}</figcaption>
        {summary.skills.length ? (
          <Chart option={wordOption} label={tr('热门技能词云；具体数量可在下方统计明细中查看')} />
        ) : (
          <p className={s.note}>
            {tr('当前样本尚未提取到技能，可在“目标岗位”补充并校对岗位要求。')}
          </p>
        )}
      </figure>
      <figure className={s.chartFigure}>
        <h3>{tr('岗位薪资分布')}</h3>
        <figcaption>
          {' '}
          {tr('每个圆点是一条披露薪资的岗位，纵轴使用区间中点；额外月薪次数保留在原文中。')}{' '}
        </figcaption>
        <label className={s.field} style={{ maxWidth: 280 }}>
          <span>{tr('选择币种与支付周期')}</span>
          <select value={group} onChange={(e) => setSelectedGroup(e.target.value)}>
            {groups.map((value) => (
              <option key={value} value={value}>
                {value.split('/')[0]} / {tr(units[value.split('/')[1]] || value.split('/')[1])}
              </option>
            ))}
          </select>
        </label>
        {groups.length ? (
          <Chart
            option={salaryOption}
            label={tr('同币种同周期的岗位薪资散点图；精确区间见统计明细')}
          />
        ) : (
          <p className={s.note}>{tr('当前样本没有纳入图表的薪资数据。')}</p>
        )}
      </figure>
      <figure className={s.chartFigure}>
        <h3>{tr('各类岗位的技能分布')}</h3>
        <figcaption>
          {' '}
          {tr(
            '每个格子的比例 = 该类中提及技能的岗位数 / 该类岗位总数。展示总体频次最高的八项技能。'
          )}{' '}
        </figcaption>
        {summary.skills.length && summary.distribution.length ? (
          <Chart
            option={skillOption}
            label={tr('各岗位类别的技能占比热力图；分母与数量见统计明细')}
          />
        ) : (
          <p className={s.note}>{tr('提取岗位技能后，这里将展示各类别的技能占比。')}</p>
        )}
      </figure>
    </div>
  );
}
