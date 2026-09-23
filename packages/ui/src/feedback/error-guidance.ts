import type { ApiErrorCode } from "@agent-platform/contracts";

/**
 * 오류는 원문 대신 "할 일"을 먼저 말한다 (02 UX 설계 §9). The server message is
 * kept as the secondary line; this is what the reader acts on.
 */
export const ERROR_GUIDANCE: Record<ApiErrorCode, string> = {
  BAD_REQUEST: "입력을 확인하고 다시 보내세요.",
  UNAUTHORIZED: "로그인이 만료됐습니다 — 다시 로그인하세요.",
  FORBIDDEN: "권한이 없습니다 — 관리자에게 요청하세요.",
  BOOTSTRAP_DONE: "이미 관리자가 만들어져 있습니다 — 로그인 화면으로 가세요.",
  NOT_FOUND: "대상을 찾을 수 없습니다 — 목록에서 다시 여세요.",
  PAYLOAD_TOO_LARGE: "내용이 너무 큽니다 — 나눠서 보내세요.",
  REQUEST_TIMEOUT:
    "전송이 제때 끝나지 않았습니다 — 연결을 확인하고 다시 보내세요.",
  UNSUPPORTED_CAPABILITY: "이 런타임이 지원하지 않는 기능입니다.",
  RATE_LIMITED: "요청이 몰렸습니다 — 잠시 뒤 다시 시도하세요.",
  STORAGE_LIMIT_EXCEEDED:
    "저장 한도를 다 썼습니다 — 운영자에게 한도를 늘려 달라고 요청하세요.",
  INTERNAL_ERROR: "서버에서 처리하지 못했습니다 — 잠시 뒤 다시 시도하세요.",
  REVISION_CONFLICT: "다른 사람이 먼저 바꿨습니다 — 최신 내용을 확인하세요.",
  IDEMPOTENCY_CONFLICT:
    "같은 요청이 이미 접수됐습니다 — 접수 결과를 확인하세요.",
  REQUEST_EXPIRED: "요청이 만료됐습니다 — 다시 요청하세요.",
  REQUEST_STALE: "화면이 오래됐습니다 — 새로 고친 뒤 다시 시도하세요.",
  SESSION_PAUSED: "세션이 일시정지 상태입니다 — 재개한 뒤 보내세요.",
  SESSION_RESUMING: "세션을 복원하는 중입니다 — 잠시 뒤 다시 시도하세요.",
  SESSION_CLOSED: "보관된 세션입니다 — 새 세션으로 이어가세요.",
  SESSION_STOPPED: "종료된 세션입니다 — 재개한 뒤 보내세요.",
  RECOVERY_REQUIRED: "결과를 확인해야 합니다 — 복구 결정을 내리세요.",
  CHECKPOINT_UNAVAILABLE: "복원 지점을 읽지 못했습니다 — 담당자에게 알리세요.",
  PAUSE_COMMITTING: "일시정지를 마무리하는 중입니다 — 잠시 뒤 다시 시도하세요.",
  PAUSE_CANCELLED: "일시정지가 취소됐습니다 — 현재 상태를 확인하세요.",
  CONTROL_SUPERSEDED:
    "더 최근 제어가 먼저 적용됐습니다 — 현재 상태를 확인하세요.",
  TURN_NOT_STARTED:
    "아직 시작하지 않은 턴은 중단할 수 없습니다 — 실행이 시작된 뒤 다시 시도하세요.",
  BACKEND_UNAVAILABLE:
    "실행 환경에 연결하지 못했습니다 — 잠시 뒤 다시 시도하세요.",
  LAUNCH_FAILED:
    "작업 환경을 여러 번 띄우지 못해 입력이 처리되지 않았습니다 — 담당자에게 알린 뒤 다시 보내세요.",
  NOT_READY: "아직 준비되지 않았습니다 — 잠시 뒤 다시 시도하세요.",
  CURSOR_EXPIRED: "이어보기 위치가 만료됐습니다 — 처음부터 다시 불러오세요.",
  LEASE_EXPIRED: "실행 점유가 만료됐습니다 — 현재 상태를 확인하세요.",
  STALE_EPOCH: "오래된 실행에서 온 응답입니다 — 현재 상태를 확인하세요.",
};

/** Unknown codes fall back to a neutral instruction rather than raw English. */
export function guidanceFor(code: string | undefined): string | undefined {
  if (!code) return undefined;
  // `hasOwn`, not a plain lookup: the code arrives from the server, and
  // "__proto__" or "constructor" would otherwise hand React an object.
  if (!Object.hasOwn(ERROR_GUIDANCE, code)) {
    return "처리하지 못했습니다 — 잠시 뒤 다시 시도하세요.";
  }
  return ERROR_GUIDANCE[code as ApiErrorCode];
}
