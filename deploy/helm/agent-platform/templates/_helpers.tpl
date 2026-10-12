{{- define "ap.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* Labels every resource carries; `component` names the workload. */}}
{{- define "ap.labels" -}}
{{ include "ap.selectorLabels" . }}
app.kubernetes.io/part-of: agent-platform
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
{{- end -}}

{{- define "ap.selectorLabels" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
<registry>/<repository>@<digest>, or a failed render: the scheduler's
kubernetes backend refuses a bare tag, and so does this chart for every image.
*/}}
{{- define "ap.image" -}}
{{- $image := index .root.Values.images .name -}}
{{- $repository := required (printf "images.%s.repository is required" .name) $image.repository -}}
{{- if regexMatch "@|:[^/]+$" $repository -}}
{{- fail (printf "images.%s.repository must not carry a tag or digest (got %q); set images.%s.digest" .name $repository .name) -}}
{{- end -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" (toString $image.digest)) -}}
{{- fail (printf "images.%s.digest must be sha256:<64 hex> (got %q): every image is pinned by digest" .name (toString $image.digest)) -}}
{{- end -}}
{{- $registry := .root.Values.images.registry | trimSuffix "/" -}}
{{- if $registry -}}
{{- printf "%s/%s@%s" $registry $repository $image.digest -}}
{{- else -}}
{{- printf "%s@%s" $repository $image.digest -}}
{{- end -}}
{{- end -}}

{{- define "ap.installationId" -}}
{{- $id := toString .Values.installationId -}}
{{- if not (regexMatch "^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$" $id) -}}
{{- fail (printf "installationId must be a Kubernetes label value (got %q)" $id) -}}
{{- end -}}
{{- $id -}}
{{- end -}}

{{- define "ap.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "ap.containerSecurityContext" -}}
runAsNonRoot: true
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "ap.imagePullSecrets" -}}
{{- with .Values.images.pullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "ap.secretEnv" -}}
- name: {{ .key }}
  valueFrom:
    secretKeyRef:
      name: {{ .root.Values.secrets.name }}
      key: {{ .key }}
{{- end -}}

{{/* The checkpoint object store settings the api and the checkpoint GC share. */}}
{{- define "ap.checkpointEnv" -}}
- name: AWS_REGION
  value: {{ .Values.config.aws.region | quote }}
- name: S3_BUCKET
  value: {{ .Values.config.checkpoints.bucket | quote }}
- name: CHECKPOINT_OBJECT_PROTECTION
  value: {{ .Values.config.checkpoints.protection | quote }}
{{- with .Values.config.aws.endpointUrl }}
- name: AWS_ENDPOINT_URL
  value: {{ . | quote }}
{{- end }}
{{- /* Without them the object store uses the AWS default credential chain
(IRSA). Set in the environment, the keys would also win over the role. */}}
{{- if .Values.secrets.objectStoreKeys }}
{{ include "ap.secretEnv" (dict "root" . "key" "AWS_ACCESS_KEY_ID") }}
{{ include "ap.secretEnv" (dict "root" . "key" "AWS_SECRET_ACCESS_KEY") }}
{{- end }}
{{- end -}}

{{- define "ap.extraEnv" -}}
{{- range $name, $value := . }}
- name: {{ $name }}
  value: {{ $value | toString | quote }}
{{- end }}
{{- end -}}

{{/* /tmp is the only writable path: the root filesystem is read-only. */}}
{{- define "ap.tmpVolume" -}}
- name: tmp
  emptyDir:
    sizeLimit: 1Gi
{{- end -}}

{{- define "ap.tmpMount" -}}
- name: tmp
  mountPath: /tmp
{{- end -}}

{{- define "ap.apiHost" -}}{{ include "ap.fullname" . }}-api{{- end -}}
{{- define "ap.proxyHost" -}}{{ include "ap.fullname" . }}-egress-proxy{{- end -}}
