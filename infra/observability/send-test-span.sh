#!/bin/sh
# Sends one test trace shaped like Werft's planned spans (a werft.turn with a
# model call and a tool call under it) to an OTLP/HTTP endpoint, and with
# --with-log one log record in the same trace. Prints the trace id.
#
#   infra/observability/send-test-span.sh http://127.0.0.1:26318 --with-log
set -eu

endpoint=${1:?usage: send-test-span.sh <otlp-http-endpoint> [--with-log]}
with_log=${2:-}

trace_id=$(openssl rand -hex 16)
turn_span=$(openssl rand -hex 8)
llm_span=$(openssl rand -hex 8)
tool_span=$(openssl rand -hex 8)
session_id="ses_test_$(openssl rand -hex 4)"
now=$(date +%s)
t() { echo "$((now + $1))000000000"; }

resource='{"attributes":[
  {"key":"service.name","value":{"stringValue":"werft-api"}},
  {"key":"service.namespace","value":{"stringValue":"werft"}},
  {"key":"service.version","value":{"stringValue":"0.0.0-example"}}]}'

post() {
  status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$endpoint/$1" \
    -H 'Content-Type: application/json' --data-binary "$2")
  case $status in
    2*) ;;
    *) echo "POST $endpoint/$1 returned HTTP $status" >&2; exit 1 ;;
  esac
}

post v1/traces "{\"resourceSpans\":[{\"resource\":$resource,\"scopeSpans\":[{\"scope\":{\"name\":\"werft.example\"},\"spans\":[
  {\"traceId\":\"$trace_id\",\"spanId\":\"$turn_span\",\"name\":\"werft.turn\",\"kind\":1,
   \"startTimeUnixNano\":\"$(t 0)\",\"endTimeUnixNano\":\"$(t 3)\",
   \"attributes\":[
     {\"key\":\"werft.session_id\",\"value\":{\"stringValue\":\"$session_id\"}},
     {\"key\":\"session.id\",\"value\":{\"stringValue\":\"$session_id\"}},
     {\"key\":\"gen_ai.conversation.id\",\"value\":{\"stringValue\":\"$session_id\"}},
     {\"key\":\"gen_ai.input.messages\",\"value\":{\"stringValue\":\"[{\\\"role\\\":\\\"user\\\",\\\"parts\\\":[{\\\"type\\\":\\\"text\\\",\\\"content\\\":\\\"List the files in the repository.\\\"}]}]\"}}]},
  {\"traceId\":\"$trace_id\",\"spanId\":\"$llm_span\",\"parentSpanId\":\"$turn_span\",\"name\":\"werft.llm_request\",\"kind\":3,
   \"startTimeUnixNano\":\"$(t 0)\",\"endTimeUnixNano\":\"$(t 1)\",
   \"attributes\":[
     {\"key\":\"gen_ai.operation.name\",\"value\":{\"stringValue\":\"chat\"}},
     {\"key\":\"gen_ai.request.model\",\"value\":{\"stringValue\":\"example-model\"}},
     {\"key\":\"gen_ai.usage.input_tokens\",\"value\":{\"intValue\":\"120\"}},
     {\"key\":\"gen_ai.usage.output_tokens\",\"value\":{\"intValue\":\"30\"}},
     {\"key\":\"gen_ai.output.messages\",\"value\":{\"stringValue\":\"[{\\\"role\\\":\\\"assistant\\\",\\\"parts\\\":[{\\\"type\\\":\\\"text\\\",\\\"content\\\":\\\"I will run ls.\\\"}]}]\"}}]},
  {\"traceId\":\"$trace_id\",\"spanId\":\"$tool_span\",\"parentSpanId\":\"$turn_span\",\"name\":\"werft.tool\",\"kind\":1,
   \"startTimeUnixNano\":\"$(t 1)\",\"endTimeUnixNano\":\"$(t 2)\",
   \"attributes\":[
     {\"key\":\"gen_ai.operation.name\",\"value\":{\"stringValue\":\"execute_tool\"}},
     {\"key\":\"gen_ai.tool.name\",\"value\":{\"stringValue\":\"Bash\"}},
     {\"key\":\"gen_ai.tool.call.id\",\"value\":{\"stringValue\":\"toolu_example\"}}]}
]}]}]}"

if [ "$with_log" = --with-log ]; then
  post v1/logs "{\"resourceLogs\":[{\"resource\":$resource,\"scopeLogs\":[{\"scope\":{\"name\":\"werft.example\"},\"logRecords\":[
    {\"timeUnixNano\":\"$(t 3)\",\"severityNumber\":9,\"severityText\":\"INFO\",
     \"traceId\":\"$trace_id\",\"spanId\":\"$turn_span\",
     \"body\":{\"stringValue\":\"turn finished\"},
     \"attributes\":[{\"key\":\"werft.session_id\",\"value\":{\"stringValue\":\"$session_id\"}}]}
  ]}]}]}"
fi

echo "trace_id=$trace_id session_id=$session_id"
