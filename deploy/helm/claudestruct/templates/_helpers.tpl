{{/*
Expand the name of the chart.
*/}}
{{- define "claudestruct.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name. Truncated at 63 chars
because some Kubernetes name fields are limited to that.
*/}}
{{- define "claudestruct.fullname" -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "claudestruct.labels" -}}
app.kubernetes.io/name: {{ include "claudestruct.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/*
Selector labels (subset of the above; must match deployment selector
which is immutable).
*/}}
{{- define "claudestruct.selectorLabels" -}}
app.kubernetes.io/name: {{ include "claudestruct.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Resolve the secret name -- existing if set, otherwise the rendered
inline secret.
*/}}
{{- define "claudestruct.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "claudestruct.fullname" .) -}}
{{- end -}}
{{- end -}}
