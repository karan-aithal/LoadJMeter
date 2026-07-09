cd C:\Users\karanr.aithal\Documents\2WebApp\LoadJMeter

# Generate secrets
$JWT = -join ((65..90)+(97..122)+(48..57) | Get-Random -Count 40 | ForEach-Object {[char]$_})
$KEY = -join ((65..90)+(97..122)+(48..57) | Get-Random -Count 20 | ForEach-Object {[char]$_})

@"
SUT_PORT=3000
SLOW_DELAY_MS=200
FIB_N=35

PROMETHEUS_PORT=9090
GRAFANA_PORT=3001
GRAFANA_PASSWORD=admin

CONTROL_API_PORT=4000
JWT_SECRET=$JWT
API_KEY=$KEY
DATABASE_URL=postgresql://loadtest:changeme@postgres:5432/loadtest

REDIS_URL=redis://redis:6379

CONTROL_API_URL=http://control-api:4000
HEARTBEAT_INTERVAL_MS=5000
MAX_RETRIES=3
DEAD_LETTER_QUEUE=dead-letter
"@ | Set-Content .env

# Show the generated values so you can use them
Write-Host "API_KEY = $KEY"
Write-Host "JWT_SECRET = $JWT"



# Step 3 — get a token using the generated API_KEY:
$API_KEY = (Get-Content .env | Select-String '^API_KEY=').ToString().Split('=',2)[1]

$body = '{"apiKey":"' + $API_KEY + '"}'
$response = Invoke-RestMethod -Method Post -Uri http://localhost:4000/auth/token `
  -ContentType 'application/json' -Body $body
$TOKEN = $response.token
echo $TOKEN