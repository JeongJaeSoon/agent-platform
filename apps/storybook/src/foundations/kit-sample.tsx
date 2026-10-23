import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  FieldError,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
  Stepper,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@werft-ai/ui";

/**
 * Most of packages/ui in one column, for the Foundations views that render
 * the kit under one theme or without Tailwind's preflight. Dialogs are left
 * out: they portal to document.body, outside whatever wraps this.
 */
export function KitSample({ scope }: { readonly scope?: string }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2">
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
        <Button type="button" disabled={true}>
          잠김
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge variant="gray">초안</Badge>
        <Badge variant="blue">진행 중</Badge>
        <Badge variant="green">연결됨</Badge>
        <Badge variant="amber">확인 필요</Badge>
        <Badge variant="red">실패</Badge>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>팀 이름</FieldLabel>
          <Input defaultValue="결제" />
          <FieldError>이미 있는 팀 이름입니다.</FieldError>
        </Field>
        <Field>
          <FieldLabel>역할</FieldLabel>
          <NativeSelect defaultValue="member">
            <NativeSelectOption value="admin">관리자</NativeSelectOption>
            <NativeSelectOption value="member">멤버</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel>지시문</FieldLabel>
          <Textarea placeholder="에이전트가 할 일을 적습니다" />
        </Field>
        <div className="flex flex-col gap-3">
          <Field orientation="horizontal">
            <Checkbox defaultChecked={true} />
            <FieldLabel>승인 요청이 오면 알립니다</FieldLabel>
          </Field>
          <RadioGroup defaultValue="team" aria-label="공유 범위">
            <Field orientation="horizontal">
              <RadioGroupItem value="private" />
              <FieldLabel>나만</FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <RadioGroupItem value="team" />
              <FieldLabel>팀</FieldLabel>
            </Field>
          </RadioGroup>
        </div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>결제 담당</CardTitle>
          <CardDescription>
            청구서 문의에 답하고 환불을 접수합니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">개요</TabsTrigger>
              <TabsTrigger value="sessions">세션</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              에이전트가 하는 일과 상태
            </TabsContent>
            <TabsContent value="sessions">최근 세션 목록</TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      <Stepper
        // Two samples on one page need two names for their <nav>.
        label={["에이전트 만들기 단계", scope].filter(Boolean).join(" · ")}
        currentStepId="model"
        steps={[
          { id: "basics", label: "기본 정보" },
          { id: "model", label: "모델" },
          { id: "review", label: "검토" },
        ]}
      />
      <EmptyState
        title="아직 세션이 없습니다"
        description="에이전트에게 첫 지시를 보내면 여기에 쌓입니다."
      />
      <ErrorState message="session is closed" code="SESSION_CLOSED" />
      <Skeleton lines={2} label="불러오는 중" />
    </div>
  );
}
