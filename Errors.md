No Output for these commands

# Get token
TOKEN=$(curl -sf -X POST http://localhost:4000/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":"'$API_KEY'"}' | jq -r .token)
echo $TOKEN   # should be a long JWT string

# POST test (with idempotency key)
curl -sf -X POST http://localhost:4000/tests \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: test-001" \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"fast","vus":5,"duration":"10s"}' | jq .

# Same key again → idempotent return (HTTP 200, same id)
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:4000/tests \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: test-001" \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"fast","vus":5,"duration":"10s"}'



  Error -
  # Validation guardrail
  curl -s -X POST http://localhost:4000/tests \s \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: test-bad" \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"fast","vus":9999,"duration":"10s"}' | jq .error
"Authorization: Bearer <token> required"