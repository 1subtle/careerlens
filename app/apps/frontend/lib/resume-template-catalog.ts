import type { TemplateType } from './types/template-settings';

export const RESUME_TEMPLATE_CATALOG: {
  id: TemplateType;
  name: string;
  description: string;
  category: string;
}[] = [
  {
    id: 'campus',
    name: '校招清晰',
    description: '院校学历置顶，蓝色标题与右侧照片',
    category: '单栏',
  },
  {
    id: 'ledger',
    name: '标准表格',
    description: '左侧栏目、细线分格，信息逐项对齐',
    category: '表格',
  },
  {
    id: 'timeline',
    name: '蓝色时间线',
    description: '色块页首与纵向线条，突出经历顺序',
    category: '单栏',
  },
  {
    id: 'fresh',
    name: '清新雅致',
    description: '青绿色细框与标签标题，疏朗易读',
    category: '单栏',
  },
  {
    id: 'sidebar',
    name: '简约侧栏',
    description: '个人资料居左，教育与项目集中在右侧',
    category: '双栏',
  },
  { id: 'swiss-single', name: '经典商务', description: '黑白分节，适合通用岗位', category: '单栏' },
  { id: 'clean', name: '简约清晰', description: '轻量标题，突出经历内容', category: '单栏' },
  { id: 'modern', name: '现代专业', description: '蓝色强调，适合产品与技术岗位', category: '单栏' },
  { id: 'latex', name: '学术研究', description: '宋体正文，适合科研与学术申请', category: '单栏' },
  { id: 'vivid', name: '创意双栏', description: '侧栏信息，适合设计与创意岗位', category: '双栏' },
];
