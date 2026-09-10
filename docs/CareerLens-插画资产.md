# CareerLens 插画资产

生成日期：2026-09-08。使用 `imagegen` skill 与 Codex 内置 `image_gen.imagegen` 图像工具，三件资产分别生成。没有使用 CLI、外部 API key、素材网站或占位图。

采用 Playful Illustration 风格：圆润手绘造型、粗深紫轮廓，搭配紫、珊瑚橙、黄、青柠与奶油色。奶油色用于纸张等物件填充，画布保留透明背景。

## 交付文件

文件位于 `app/apps/frontend/public/illustrations/`。PNG 是所选生成原图的逐字节副本；WebP 为现有 sharp 导出的无损副本，未裁切、改色或重画。

| 文件 | 像素尺寸 | 文件字节数 | 用途 |
| --- | --- | ---: | --- |
| careerlens-icon.png | 1254 × 1254 | 853545 | 品牌应用图标原图 |
| careerlens-icon.webp | 1254 × 1254 | 567978 | 页面品牌图像 |
| career-guide.png | 1536 × 1024 | 1417849 | 简历引导插图原图 |
| career-guide.webp | 1536 × 1024 | 577796 | 简历引导页面插图 |
| opportunity-discovery.png | 1536 × 1024 | 1377396 | 机会发现插图原图 |
| opportunity-discovery.webp | 1536 × 1024 | 497930 | 实时岗位页面插图 |
| careerlens-favicon.png | 64 × 64 | 7416 | 页面 favicon |
| apple-icon.png | 180 × 180 | 34140 | Apple touch icon |

图像逐张检查了主体、无文字约束、构图、尺寸与 alpha 通道。三张 PNG 与三张 WebP 均含 alpha。原图中的透明像素保留生成器写入的 RGB，部分忽略 alpha 的预览会显示这些隐藏色；网页应按 PNG/WebP alpha 正常合成。小图标仅由品牌原图等比缩小。

## 原图来源与完整生成提示词

### careerlens-icon

原始生成文件：`/Users/nresearch/.codex/generated_images/01a08005-61cb-70f2-a61e-414f8821ff19/exec-b58c9398-e1ea-462c-95ae-fea40ba71d0f.png`。

```text
Create a polished brand application icon for CareerLens as one standalone square PNG image, approximately 1024 by 1024 pixels, with REAL TRANSPARENT background. Playful flat 2D hand-drawn sticker illustration, friendly rounded silhouettes, bold thick smooth deep-purple #292237 outlines with round caps and joins, deliberately simple and visually cohesive. Palette limited to lavender purple #8064EE, coral orange #FF7659, warm yellow #FFE368, fresh lime green #C4ED85, and pale cream #FFF9DF used only inside objects. Solid flat fills, clean expressive shapes. Genuine transparent alpha canvas, no colored rectangular backdrop, no checkerboard drawn into the artwork, no border or external sticker halo. No gradients, no shadows, no 3D, no photographs, no UI screenshot, no text, no lettering, no watermark, no logos. Generous breathing room, all forms fully within frame. The single compact recognizable emblem is a cute purple magnifying glass integrated with a small pale-cream resume paper. A coral handle angles down-right. The paper has rounded corners and only two bold short decorative horizontal marks plus one small yellow star representing a personal strength; these are graphic marks, not written words. A tiny friendly curved smile may live on the paper, but keep the emblem iconic and very simple. The lens should clearly read as a magnifying glass; its interior may use a pale-cream fill. Large central emblem occupies roughly 78 percent of the square, thick rounded outlines, crisp at app icon size. No MoChi branding. No miniature decoration or fine detail. Transparent surrounding canvas is essential.
```

### career-guide

原始生成文件：`/Users/nresearch/.codex/generated_images/01a08005-61cb-70f2-a61e-414f8821ff19/exec-4bb65744-15e1-44c5-bb1f-227c2fa50402.png`。

```text
Create one standalone wide 3:2 PNG illustration for CareerLens, approximately 1536 by 1024 pixels, with REAL TRANSPARENT background. Playful flat 2D hand-drawn sticker illustration, friendly rounded silhouettes, bold thick smooth deep-purple #292237 outlines with round caps and joins, deliberately simple and visually cohesive. Palette limited to lavender purple #8064EE, coral orange #FF7659, warm yellow #FFE368, fresh lime green #C4ED85, and pale cream #FFF9DF used only inside objects. Solid flat fills, clean expressive shapes. Genuine transparent alpha canvas, no colored rectangular backdrop, no checkerboard drawn into the artwork, no border or external sticker halo. No gradients, no shadows, no 3D, no photographs, no UI screenshot, no text, no lettering, no watermark, no logos. Generous breathing room, all forms fully within frame. A friendly anthropomorphic pale-cream resume sheet with rounded corners stands slightly left of center, little purple rounded arms, a simple happy face, and a few broad purple graphic lines (no writing). Beside it a large purple magnifying glass with coral handle examines a bright yellow star on the paper, expressing finding one's strengths and organizing career experiences. Add one chunky coral pencil with yellow tip diagonally on the right and two small lime/yellow four-point sparkles. Balanced compact central group, softly asymmetric composition, objects occupy about 80 percent width and 78 percent height. Shapes feel charming and handmade but edges remain clear; this must feel like a designed illustration, not a clipart collage. Match a family of bold purple outlined playful resume/magnifier stickers. No speech bubbles, words or UI. Transparent surrounding canvas is essential.
```

### opportunity-discovery

原始生成文件：`/Users/nresearch/.codex/generated_images/01a08005-61cb-70f2-a61e-414f8821ff19/exec-079a7244-8d49-4fd3-ad93-6c0f4397f045.png`。

```text
Create one standalone wide 3:2 PNG illustration for CareerLens, approximately 1536 by 1024 pixels, with REAL TRANSPARENT background. Playful flat 2D hand-drawn sticker illustration, friendly rounded silhouettes, bold thick smooth deep-purple #292237 outlines with round caps and joins, deliberately simple and visually cohesive. Palette limited to lavender purple #8064EE, coral orange #FF7659, warm yellow #FFE368, fresh lime green #C4ED85, and pale cream #FFF9DF used only inside objects. Solid flat fills, clean expressive shapes. Genuine transparent alpha canvas, no colored rectangular backdrop, no checkerboard drawn into the artwork, no border or external sticker halo. No gradients, no shadows, no 3D, no photographs, no UI screenshot, no text, no lettering, no watermark, no logos. Generous breathing room, all forms fully within frame. A cute chunky lavender-purple telescope with coral eyepiece and a simple rounded support on the left points diagonally toward three separate little job-opportunity note papers fanned out to the upper right. The rounded papers are pale cream, yellow, and lime with just a few broad dark-purple graphic strokes (not writing); one has a small star. A small coral paper airplane flies above the notes, and two tiny four-point yellow/purple sparkles suggest discovery. Friendly simple shapes, thick rounded outlines, confident flat graphic design, consistent with a playful resume-and-magnifying-glass sticker illustration family. Balanced central group, about 80 percent canvas width and 78 percent height, generous transparent breathing room. Express finding and comparing new career opportunities; no charts, no screen, no text, no branding. Transparent surrounding canvas is essential.
```


## 生成过程

两张宽插图曾尝试进一步简化边缘。第一轮编辑结果带有绘制的棋盘格且没有 alpha，未选用；第二轮保留 alpha，但颜色更饱和，也未选用。交付使用最初生成、具备有效 alpha 的三张原图；所有生成文件仍保留在上述原图目录。

衍生图使用现有 sharp：宽插图与页面品牌图采用 `webp({ lossless: true })`，小图标采用 `resize(64, 64)` 和 `resize(180, 180)` 后保存为 PNG。
