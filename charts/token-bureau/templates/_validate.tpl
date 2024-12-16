{{/*
Validate required values are provided
*/}}
{{- define "token-bureau.validateValues" -}}
{{- if not .Values.existingSecret -}}
token-bureau: existingSecret
    You must provide an existing secret name containing GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.
    Please set .Values.existingSecret
{{- end -}}
{{- end -}}
