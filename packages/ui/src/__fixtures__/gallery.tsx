import type { JSX } from "react";

import { ConfirmDialog } from "../dialog/confirm-dialog.tsx";
import { DestructiveActionDialog } from "../dialog/destructive-action-dialog.tsx";
import { EmptyState } from "../feedback/empty-state.tsx";
import { ErrorState } from "../feedback/error-state.tsx";
import { Skeleton } from "../feedback/skeleton.tsx";
import { Badge } from "../primitives/badge.tsx";
import { Button } from "../primitives/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../primitives/card.tsx";
import { ReceiptLink } from "../receipt/receipt-link.tsx";
import { ReceiptSummary } from "../receipt/receipt-summary.tsx";
import { StatusLabel } from "../status/status-label.tsx";
import {
  STATUS_VOCABULARY,
  type StatusAxis,
  type StatusStateOf,
} from "../status/vocabulary.ts";

/*
 * One render that touches every token and every component state, so a
 * snapshot catches drift; apps/storybook shows the same set one story at a
 * time. Everything in it is fixed — no clocks, no ids, no randomness — or the
 * snapshot would be noise.
 */

const SESSION_ID = "01J8Z5T7Q0000000000000000A";
const TURN_ID = "01J8Z5T7Q0000000000000000B";
const REQUEST_ID = "01J8Z5T7Q0000000000000000C";
const CREATED_AT = "2026-09-21T02:15:00.000Z";
const UPDATED_AT = "2026-09-21T02:15:42.000Z";

function noop(): void {}

function AxisRow<A extends StatusAxis>({ axis }: { axis: A }): JSX.Element {
  const states = Object.keys(STATUS_VOCABULARY[axis]) as StatusStateOf<A>[];
  return (
    <section>
      <h3>{axis}</h3>
      <div className="gallery__row">
        {states.map((state) => (
          <StatusLabel key={String(state)} axis={axis} state={state} />
        ))}
      </div>
    </section>
  );
}

export interface GalleryProps {
  /** Rendered open so the snapshot covers dialog layout at every width. */
  readonly openDialog?: "confirm" | "destructive" | undefined;
}

export function Gallery({ openDialog }: GalleryProps = {}): JSX.Element {
  return (
    <div className="gallery">
      <h2>StatusLabel</h2>
      <AxisRow axis="admission" />
      <AxisRow axis="turn" />
      <AxisRow axis="receipt" />
      <AxisRow axis="execution" />
      <div className="gallery__row">
        <StatusLabel
          axis="turn"
          state="running"
          detail="2분 12초 경과"
          stale={true}
        />
        <StatusLabel
          axis="admission"
          state="paused"
          label="관리자가 세웠습니다"
        />
        {/* An unbreakable identifier: the case that pushed the row past 360px
            before `.ap-status__detail` got a min-width of 0. */}
        <StatusLabel
          axis="execution"
          state="suspended"
          detail={`exec_${"0".repeat(60)}`}
        />
      </div>

      <h2>Receipt</h2>
      <ReceiptSummary
        operation="append_message"
        status="accepted"
        target={{
          session_id: SESSION_ID,
          turn_id: TURN_ID,
          request_id: REQUEST_ID,
        }}
        timestamps={{ created_at: CREATED_AT, updated_at: CREATED_AT }}
        action={
          <ReceiptLink
            receiptId="rcpt_01J8Z5"
            status="accepted"
            href="/receipts/rcpt_01J8Z5"
          />
        }
      />
      <ReceiptSummary
        operation="terminate"
        status="unknown"
        target={{ session_id: SESSION_ID, turn_id: null, request_id: null }}
        timestamps={{ created_at: CREATED_AT, updated_at: UPDATED_AT }}
      />
      <ReceiptSummary
        operation="answer"
        status="failed"
        target={{ session_id: SESSION_ID, turn_id: TURN_ID, request_id: null }}
        timestamps={{ created_at: CREATED_AT, updated_at: UPDATED_AT }}
        error={{ code: "SESSION_PAUSED", message: "session is paused" }}
      />

      <h2>Empty · Error · Skeleton</h2>
      <EmptyState
        title="아직 세션이 없습니다"
        description="에이전트에게 첫 지시를 보내면 여기에 쌓입니다."
        action={<Button type="button">새 세션</Button>}
        secondaryAction={
          <Button type="button" variant="ghost">
            에이전트 보기
          </Button>
        }
      />
      <ErrorState
        message="session is closed"
        code="SESSION_CLOSED"
        retry={noop}
        evidenceLink={{ href: "/sessions/01J8Z5/journal" }}
      />
      <Skeleton lines={3} />
      <Skeleton shape="circle" />
      <Skeleton shape="block" height="6rem" />

      <h2>Button · Badge · Card</h2>
      <div className="gallery__row">
        <Button type="button">기본</Button>
        <Button type="button" variant="outline">
          테두리
        </Button>
        <Button type="button" variant="secondary">
          보조
        </Button>
        <Button type="button" variant="ghost">
          조용히
        </Button>
        <Button type="button" variant="destructive">
          삭제
        </Button>
        <Button type="button" variant="link">
          링크
        </Button>
        <Button type="button" size="sm">
          작게
        </Button>
        <Button type="button" disabled={true}>
          잠김
        </Button>
        <Button asChild={true} variant="outline">
          <a href="/agents">링크를 버튼처럼</a>
        </Button>
      </div>
      <div className="gallery__row">
        <Badge>기본</Badge>
        <Badge variant="secondary">보조</Badge>
        <Badge variant="destructive">위험</Badge>
        <Badge variant="outline">테두리</Badge>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>결제 담당</CardTitle>
          <CardDescription>
            청구서 문의에 답하고 환불을 접수합니다.
          </CardDescription>
          <CardAction>
            <Badge variant="outline">초안</Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          {/* An unbreakable identifier, as in the StatusLabel row above. */}
          <p className="break-all font-mono text-sm">{`agt_${"0".repeat(60)}`}</p>
        </CardContent>
        <CardFooter className="gap-2">
          <Button type="button">이어서 설정</Button>
          <Button type="button" variant="ghost">
            나중에
          </Button>
        </CardFooter>
      </Card>

      <h2>Dialog</h2>
      <ConfirmDialog
        open={openDialog === "confirm"}
        onOpenChange={noop}
        title="세션을 일시정지할까요?"
        consequence="실행 중인 턴은 마무리하고, 대기 중인 지시는 그대로 남습니다."
        confirmLabel="일시정지"
        onConfirm={noop}
      />
      <DestructiveActionDialog
        open={openDialog === "destructive"}
        onOpenChange={noop}
        title="에이전트를 해고할까요?"
        consequence="카드와 release가 비활성화되고, 진행 중인 세션은 종료됩니다."
        resourceName="결제 담당"
        onConfirm={noop}
      />
    </div>
  );
}
