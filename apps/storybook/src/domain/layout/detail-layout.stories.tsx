import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  DetailLayout,
  DetailRail,
  DetailRailSection,
} from "@werft-ai/react/components";
import { Badge, KeyValueList, PageHeader } from "@werft-ai/ui";
import { expect } from "storybook/test";

import { MOBILE, ScreenShell } from "../../screens/screen-kit.tsx";

/*
 * The right rail of a detail page (V4-RAIL, after Cloudflare's domain
 * overview): from 1280px a 400px column at the screen's right edge, from the
 * top bar to the bottom, with its own scroll; the body centres in what is
 * left. Narrower, the rail is a band under the body in the same order.
 */

const ROWS = "gap-0 divide-y [&>div]:py-2";

function Rail({ sections = 3 }: { readonly sections?: number }) {
  return (
    <DetailRail label="세션 요약">
      <DetailRailSection title="답변 대기 요청">
        <p className="m-0 text-caption text-muted-foreground">
          답변 대기 · 요청이 오면 여기에 먼저 나옵니다.
        </p>
      </DetailRailSection>
      <DetailRailSection title="운영">
        <KeyValueList
          className={ROWS}
          items={[
            {
              label: "할 수 있는 조치",
              value: "지금 turn 멈추기 · 일시 정지 · 세션 종료",
            },
            {
              label: "내 권한",
              value: <Badge variant="green">할 수 있음</Badge>,
            },
          ]}
        />
      </DetailRailSection>
      {Array.from({ length: Math.max(0, sections - 2) }, (_, index) => (
        <DetailRailSection
          // biome-ignore lint/suspicious/noArrayIndexKey: static sample
          key={index}
          title={index === 0 ? "세션 정보" : `세션 정보 ${index + 1}`}
        >
          <KeyValueList
            className={ROWS}
            items={[
              { label: "에이전트", value: "아직 볼 수 없습니다" },
              {
                label: "모델",
                value: (
                  <span className="font-mono text-caption">model-default</span>
                ),
              },
              { label: "저장소", value: "demo" },
              { label: "시작한 사람·경로", value: "아직 볼 수 없습니다" },
              { label: "사용량", value: "$0.4200" },
            ]}
          />
        </DetailRailSection>
      ))}
    </DetailRail>
  );
}

function Page({
  paragraphs = 3,
  sections = 3,
}: {
  /** How long the body runs. */
  readonly paragraphs?: number;
  /** How many sections the rail holds. */
  readonly sections?: number;
}) {
  return (
    <ScreenShell
      current="sessions"
      crumb={["세션", "hello.txt 만들고 commit"]}
      flush
    >
      <DetailLayout rail={<Rail sections={sections} />}>
        <PageHeader
          title="hello.txt 만들고 commit"
          description="본문은 레일이 남긴 폭 안에서 최대 1620px까지 넓어진 뒤 가운데에 놓입니다."
        />
        <div className="flex flex-col gap-4">
          {Array.from({ length: paragraphs }, (_, index) => (
            <p
              // biome-ignore lint/suspicious/noArrayIndexKey: static sample
              key={index}
              className="m-0 rounded-card border bg-card p-4 text-body"
            >
              본문 {index + 1}. 타임라인과 작성창이 들어가는 자리입니다.
            </p>
          ))}
        </div>
      </DetailLayout>
    </ScreenShell>
  );
}

const meta = {
  title: "Domain/Layout/DetailLayout",
  component: DetailLayout,
  parameters: { layout: "fullscreen" },
  args: { children: null },
  render: (_args, context) => (
    <Page
      paragraphs={(context.parameters.paragraphs as number | undefined) ?? 3}
      sections={(context.parameters.sections as number | undefined) ?? 3}
    />
  ),
  // At whatever width the story runs: from 768px the rail keeps 24px inside
  // on every side and, from 1280px, 24px on each side of a section's line
  // (V4-RAIL-PAD); narrower, it keeps the body's gutter.
  play: async ({ canvasElement }) => {
    const content = canvasElement.querySelector<HTMLElement>(
      '[data-slot="detail-rail-content"]',
    );
    if (content === null) throw new Error("no rail content");
    const padding = (element: Element) => {
      const style = getComputedStyle(element);
      return [
        style.paddingTop,
        style.paddingRight,
        style.paddingBottom,
        style.paddingLeft,
      ];
    };
    const width = window.innerWidth;
    await expect(padding(content)).toEqual(
      width >= 768
        ? ["24px", "24px", "24px", "24px"]
        : ["24px", "16px", "16px", "16px"],
    );
    if (width < 1280) return;
    const sections = content.querySelectorAll(
      '[data-slot="detail-rail-section"]',
    );
    await expect(sections.length).toBeGreaterThanOrEqual(3);
    for (const [index, section] of sections.entries()) {
      const [top, , bottom] = padding(section);
      await expect([top, bottom]).toEqual([
        index === 0 ? "0px" : "24px",
        index === sections.length - 1 ? "0px" : "24px",
      ]);
    }
  },
} satisfies Meta<typeof DetailLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: "본문 짧음" };

/** The rail stays in view and keeps its line to the bottom as the page scrolls. */
export const LongBody: Story = {
  name: "본문 김",
  parameters: { paragraphs: 40 },
};

/** Taller than the screen, the rail scrolls on its own. */
export const LongRail: Story = {
  name: "레일 김 (자체 스크롤)",
  parameters: { sections: 9 },
};

export const Dark: Story = {
  name: "본문 짧음 (dark)",
  globals: { theme: "dark" },
};

/** Below 1280px the rail is a band under the body, its line on top. */
export const Mobile: Story = { name: "390px", globals: MOBILE };

export const MobileDark: Story = {
  name: "390px (dark)",
  globals: { ...MOBILE, theme: "dark" },
};

/** The rail at the screen's right edge, where its sections' spacing shows. */
export const Desktop: Story = {
  name: "1440px",
  globals: { viewport: { value: "desktop1440", isRotated: false } },
};
