# Đặc tả yêu cầu — Hệ thống 4 AI Agent phối hợp

**Phiên bản:** 1.0 (MVP)
**Phạm vi:** `orchestrator/` trong repo `Sales-Management-N6TT27`
**Ngôn ngữ:** TypeScript, Node.js >= 20
**Trạng thái:** Đã triển khai, có 31 test tự động; đã smoke-test end-to-end ở chế độ mock. Chưa chạy live với API key thật trong môi trường này.

---

## 1. Bối cảnh & mục tiêu

Đội phát triển hiện có backend Spring Boot, frontend React và quy ước chất lượng trong constitution (layered architecture, test là bằng chứng, tiếng Việt cho người dùng). Việc chuyển một yêu cầu thành code hoàn chỉnh cần nhiều vai trò và nhiều bước kiểm tra.

Mục tiêu của hệ thống:

- Tự động phân rã yêu cầu thành công việc backend/frontend có thứ tự.
- Giao việc cho đúng agent, theo dõi tiến độ và dependency.
- Tự động kiểm thử, tạo vòng debug có kiểm soát.
- Có con người phê duyệt hành động quan trọng.
- Xuất báo cáo để review; **không tự commit/push**.

### Vai trò

| Agent | Trách nhiệm | Quyền chính |
|---|---|---|
| **Backend** | Spring Boot: Controller → Service → Repository → Entity, JPA, validation, phân quyền, JUnit | fs, shell/test |
| **Frontend** | React + Vite, component, service gọi API, trạng thái loading/empty/error | fs, shell/test |
| **Testing** | Chạy test/build, đối chiếu acceptance, tìm regression, báo issue có bằng chứng | fs đọc, test, git diff, message |
| **Debug** | Tái hiện lỗi, tìm root cause, sửa tối thiểu, xác nhận lại | fs, shell/test |
| **Orchestrator** | Plan, DAG, scheduler, state, approval, quality loop, report | Điều phối, không tự viết code |

---

## 2. Yêu cầu chức năng

### FR-01 — Lập kế hoạch từ yêu cầu tự nhiên

**Mô tả:** Planner nhận yêu cầu tiếng Việt + repo profile, sinh JSON gồm summary, assumptions, risks và danh sách task backend/frontend.

**Quy tắc:**

- Chỉ role `backend`/`frontend`.
- Tối đa 12 task (prompt khuyến nghị 8), id duy nhất, title/description bắt buộc.
- `dependsOn` phải tồn tại, không self-dependency, không cycle.
- `acceptance` kiểm chứng được; có `filesHint`.
- Không giao việc commit/push/deploy/xóa dữ liệu/đổi secret.

**Xử lý lỗi:** Gọi lại LLM 1 lần với thông báo lỗi; nếu vẫn sai, dùng heuristic plan tối thiểu và cảnh báo trong report.

**Implementation:** `src/agents/planner.ts`, `src/agents/prompts.ts`, `src/core/plan.ts`.
**Test:** `test/plan.test.ts` (9 test).

---

### FR-02 — Scheduler theo DAG, song song theo role và có retry

**Mô tả:** Orchestrator chạy task theo dependency; task chỉ `ready` khi mọi dependency `done`; task phụ thuộc task fail bị `skipped`. Mỗi batch chọn tối đa `maxParallel` task, nhưng mỗi role chỉ một task.

**Quy tắc:**

- Chọn task `ready` theo priority, tối đa `maxParallel`, mỗi role tối đa một task/batch.
- Retry tối đa `maxTaskAttempts`; lần sau nhận feedback từ lần trước.
- Một task fail không dừng toàn bộ implementation; các task không phụ thuộc vẫn chạy.
- Task đang chạy dở khi một task khác cần approval quay về `ready` trước khi pause.
- Guard 500 vòng scheduler.

**Implementation:** `src/core/engine.ts`, `src/core/plan.ts`.
**Test:** `test/engine.test.ts`, `test/plan.test.ts`.

---

### FR-03 — Agent loop với tool calling

**Mô tả:** Mỗi agent chạy vòng ReAct: gọi LLM → thực thi tool → trả kết quả tool → lặp đến khi có final JSON hoặc hết `maxStepsPerTask`/timeout.

**Quy tắc:**

- Mọi tool call được kiểm tra policy trước khi chạy.
- Output tool bị cắt theo `maxToolOutputChars`.
- Kết quả cuối phải theo output contract; parse an toàn, không crash nếu JSON sai.
- `filesChanged`/`testsRun` được hợp nhất từ tool meta và git snapshot.

**Implementation:** `src/agents/base.ts`, `src/tools/*`, `src/core/git.ts`.
**Test:** `test/tools.test.ts`, `test/engine.test.ts`.

---

### FR-04 — Kiểm thử tự động sau implementation

**Mô tả:** Sau khi implementation kết thúc (kể cả có task fail), engine tạo task `verify-N` role testing, phụ thuộc tất cả task implementation.

**Quy tắc:**

- Testing chạy `test_run suite="all"` (backend + frontend theo config).
- Đọc diff, đối chiếu acceptance, tìm regression.
- Trả `testsRun` thật; không báo PASS nếu chưa chạy.
- Issue phải có severity, file/line (nếu có), repro, suspectedCause.

**Implementation:** `src/core/engine.ts` (`createVerifyTask`), `src/tools/test-tools.ts`.
**Test:** `test/engine.test.ts`, `test/tools.test.ts`.

---

### FR-05 — Đánh giá độc lập & bằng chứng test

**Mô tả:** Engine không tin tuyệt đối kết quả testing; tự đánh giá.

**Quy tắc:**

- Live mode + không có `testsRun` → `blocked`, không đạt.
- Test fail → thêm issue `high`.
- Chỉ issue `critical`/`high` chặn.
- `passed` chỉ khi testing `status=done`, 0 blocking, có evidence.
- Không double-count failed test (issue do engine thêm và issue agent báo được hợp nhất theo kết quả test).

**Implementation:** `src/core/engine.ts` (`evaluateVerification`).
**Test:** `test/engine.test.ts`.

---

### FR-06 — Vòng Debug có giới hạn

**Mô tả:** Khi verify chưa đạt và còn ngân sách, engine tạo `debug-N`, giao issues + output test; debug sửa và chạy lại test; sau đó tạo `verify-(N+1)`.

**Quy tắc:**

- `maxFixCycles` mặc định 3.
- Debug phải tái hiện lỗi trước khi sửa; không xóa/nới test.
- Hết vòng → `quality.passed=false`, run `completed_with_issues`.
- Testing `blocked` (thiếu môi trường/bằng chứng) không tạo debug vô ích; dừng với lý do.

**Implementation:** `src/core/engine.ts` (`runQualityLoop`, `createDebugTask`).
**Test:** `test/engine.test.ts` (test fail → debug → pass).

---

### FR-07 — Approval gate

**Mô tả:** Hành động rủi ro cần con người phê duyệt.

**Quy tắc:**

- Policy trả `allow`/`ask`/`deny`.
- `deny` → chặn cứng.
- `ask`:
  - `--yes` hoặc mode `auto` → tự duyệt.
  - Có grant khớp `(taskId, tool, argsHash)` → tiêu thụ grant.
  - Mode `gate` + TTY + interactive → hỏi trực tiếp.
  - Còn lại → tạo approval `pending`, dừng run, exit code `2`.
- Mode `deny` chặn cứng mọi `ask`, kể cả `--yes`.
- Approve qua CLI tạo grant một lần; reject không tạo grant.
- Approval detail được redact secret.

**Implementation:** `src/core/approvals.ts`, `src/core/policy.ts`, `src/cli.ts`.
**Test:** `test/tools.test.ts` (grant, mode deny), `test/engine.test.ts` (pause → resume).

---

### FR-08 — Pause / resume bền vững

**Mô tả:** Run có thể dừng khi cần duyệt hoặc do lỗi, sau đó resume từ state.

**Quy tắc:**

- `state.json` lưu task, approval, grant, quality, usage.
- Resume chuyển `needs_approval` → `ready`, không chạy lại task `done`.
- Lần bị approval pause không tiêu hao attempt.
- Không hỗ trợ chạy đồng thời hai tiến trình trên cùng run.

**Implementation:** `src/core/state.ts`, `src/core/engine.ts`, `src/cli.ts`.
**Test:** `test/state.test.ts`, `test/engine.test.ts`.

---

### FR-09 — Báo cáo

**Mô tả:** Xuất `report.md` và `summary.json` sau mỗi run (kể cả planned/failed/awaiting approval).

**Nội dung report:**

1. Tóm tắt điều hành.
2. Kế hoạch & tiến độ.
3. Kết quả từng task.
4. Vòng kiểm thử & sửa lỗi.
5. Vấn đề còn tồn tại.
6. Phê duyệt.
7. Thay đổi & cách review (`git status`, `git diff`).
8. Token/chi phí.
9. Đề xuất tiếp theo.
10. Phụ lục artifact.

**Implementation:** `src/core/reporter.ts`.
**Test:** `test/engine.test.ts` (report tồn tại).

---

### FR-10 — Giao tiếp giữa agent

**Mô tả:** Agent gửi/đọc tin nhắn qua `team_send`/`team_read`, lưu trong `messages.json`.

**Quy tắc:**

- Người nhận: backend/frontend/testing/debug/all/orchestrator.
- Tin nhắn chưa đọc của role được đưa vào prompt task tiếp theo.
- Body tối đa 4000 ký tự; inbox tối đa 12 tin.

**Implementation:** `src/core/bus.ts`, `src/tools/team-tools.ts`.
**Test:** `test/tools.test.ts`.

---

### FR-11 — Tool layer có sandbox

**Mô tả:** Cung cấp tool fs/shell/git/test/team, kiểm tra policy trước khi thực thi.

**Quy tắc:**

- Path ngoài workspace, `.git`, secret/config bảo vệ → deny.
- Shell: allowlist, deny/ask pattern, không nối lệnh/`cd`/command substitution.
- Timeout và giới hạn output/file.
- Tool lỗi trả output có hướng dẫn, trừ policy/approval được xử lý riêng.

**Implementation:** `src/tools/*`, `src/core/policy.ts`.
**Test:** `test/policy.test.ts` (8), `test/tools.test.ts`.

---

### FR-12 — CLI

**Mô tả:** Cung cấp lệnh `run`, `plan`, `resume`, `status`, `runs`, `approvals`, `approve`, `reject`, `report`, `doctor`, `help`, `version`.

**Quy tắc:**

- `runId` mặc định `latest` cho các lệnh đọc.
- Flag: `--workspace`, `--config`, `--mock`, `--yes`, `--plan-only`, `--max-cycles`, `--model`, `--base-url`, `--verbose`, `--quiet`, `--json`, `--print`, `--open`, `--online`, `--no-interactive`.
- Exit code: 0 completed/planned, 1 failed, 2 awaiting_approval, 3 completed_with_issues.

**Implementation:** `src/cli.ts`.
**Test:** Smoke test thủ công với `--mock`; không có integration test cho toàn bộ CLI.

---

### FR-13 — Cấu hình linh hoạt

**Mô tả:** Cấu hình qua default → JSON → env → CLI, có JSON Schema.

**Quy tắc:**

- `.env` chỉ nạp biến prefix `LLM_`, `AGENT_`, `ORCHESTRATOR_`.
- Placeholder `{mvnw}`, `{npm}`, `{workspace}` trong test command.
- `apiKeyEnv` cho phép đặt tên biến key khác.
- Config snapshot trong `request.md` đã redact key.

**Implementation:** `src/config.ts`, `agent.config.json`, `agent.config.schema.json`, `.env.example`.
**Test:** `test/policy.test.ts`, `test/tools.test.ts` (dùng config tùy biến).

---

### FR-14 — Bảo vệ secret & audit

**Mô tả:** Không đọc/ghi secret; redact trong log/transcript/approval.

**Quy tắc:**

- Protected: `.env`, `.env.*`, `*.pem`, `*.key`, `application-secret*`, `docs/Token.md`, `.git`, `.github`, `.specify`, node_modules/target/dist, runs.
- Redact: `sk-*`, Bearer token, api key/secret/password/token, JWT.
- Không log API key; `redactedConfig` thay bằng `[REDACTED]`.
- Transcript/event ghi ra file đều qua redaction.

**Implementation:** `src/config.ts`, `src/util/text.ts`, `src/util/logger.ts`, `src/core/approvals.ts`.
**Test:** `test/tools.test.ts` (chặn đọc secret).

---

## 3. Yêu cầu phi chức năng

| ID | Yêu cầu | Cách đáp ứng |
|---|---|---|
| NFR-01 | Chạy trên Windows và Unix | `path`, `mvnw.cmd`/`mvnw`, shell qua `spawn` với `shell: true`, không hard-code `/` |
| NFR-02 | Node >= 20, TypeScript strict | `tsconfig` strict + `noUncheckedIndexedAccess`; `tsc --noEmit` pass |
| NFR-03 | Không phụ thuộc framework nặng | Chỉ devDependency: TypeScript, tsx, vitest, @types/node |
| NFR-04 | Test tự động, không gọi API thật | ScriptedLLM/MockLLM; 31 test |
| NFR-05 | Có thể audit | `state.json`, `events.jsonl`, transcript, report |
| NFR-06 | Giới hạn tài nguyên | max steps/attempts/cycles/timeout/output/file |
| NFR-07 | An toàn mặc định | approval `gate`, policy deny, không commit/push |
| NFR-08 | Không phá công việc có sẵn | Không reset/clean; chỉ sửa file trong phạm vi task; cảnh báo dirty tree |
| NFR-09 | Dễ mở rộng | Interface LLM/tool/role tách biệt |
| NFR-10 | Báo cáo tiếng Việt | Reporter cố định tiếng Việt; message lỗi/UI trong prompt yêu cầu tiếng Việt |

---

## 4. Tiêu chí nghiệm thu (acceptance)

| ID | Tiêu chí | Bằng chứng |
|---|---|---|
| AC-01 | `plan` sinh DAG hợp lệ, không cycle, chỉ backend/frontend | `test/plan.test.ts`; smoke `plan` |
| AC-02 | `run --mock` đi hết plan → implement → verify → report | Smoke run `run-20261019-210310-3674` (exit 0) |
| AC-03 | Test fail tạo debug và verify lại; nếu pass thì quality đạt | `test/engine.test.ts` |
| AC-04 | Approval pause tạo pending, exit 2; approve + resume hoàn thành | `test/engine.test.ts`; CLI smoke |
| AC-05 | Secret path bị chặn | `test/tools.test.ts` |
| AC-06 | Shell nguy hiểm bị deny/ask đúng | `test/policy.test.ts`, `test/tools.test.ts` |
| AC-07 | State lưu/đọc/liệt kê đúng | `test/state.test.ts` |
| AC-08 | Report có đủ mục và phản ánh trạng thái thật | `test/engine.test.ts`; report smoke |
| AC-09 | Không tự commit/push | Policy deny + không có tool commit; review diff trong report |
| AC-10 | Typecheck/build/test đều pass | `npm run typecheck`, `npm run build`, `npm test` |

---

## 5. Luồng người dùng điển hình

```text
1. Người dùng: npm run agent -- run "Thêm quản lý nhà cung cấp" --yes
2. Planner: be-1 (entity/repo/service/controller) → fe-1 (service/UI) [fe-1 depends be-1]
3. Backend agent: đọc code, sửa, chạy test backend, trả result
4. Frontend agent: đọc API, sửa service/UI, chạy build, trả result
5. Testing agent: chạy backend + frontend, đọc diff, báo issue
6. Nếu fail: Debug agent sửa, Testing chạy lại (tối đa 3 vòng)
7. Orchestrator: report.md + summary.json; exit 0/3
8. Người dùng: review git diff, chạy test thủ công, commit
```

Với hành động rủi ro (ví dụ `npm install`):

```text
5a. Orchestrator tạo approval pending, dừng (exit 2)
5b. Người dùng: approvals → approve/reject → resume
```

---

## 6. Ngoài phạm vi

- Tự commit/push/merge/tạo PR.
- Chạy song song nhiều task.
- Sandbox container/VM, giới hạn network.
- Web search/browser, gọi API ngoài (trừ LLM).
- Rollback tự động hoặc merge conflict resolution.
- Multi-user, multi-tenant, authentication cho orchestrator.
- Dashboard web realtime.
- Đảm bảo code đúng tuyệt đối; con người vẫn review.

---

## 7. Giả định & quyết định thiết kế

1. **Repo là tin cậy**: orchestrator chạy trên máy dev, không phải dịch vụ public.
2. **Một run một process**: không có lock phân tán.
3. **LLM có tool calling**: provider phải hỗ trợ OpenAI function calling. Nếu không, agent chỉ trả text và có thể không hoàn thành task.
4. **Testing dùng lệnh có sẵn**: backend cần Java/Maven wrapper; frontend cần npm dependencies.
5. **Không tự cài dependency**: `npm install` cần approval; agent không được tự ý đổi lockfile.
6. **Tiếng Việt là ngôn ngữ mặc định** cho UI/message/report; code/tên biến theo convention repo.
7. **Planner chỉ backend/frontend**: testing/debug do engine sinh để đảm bảo vai trò độc lập.

---

## 8. Rủi ro & biện pháp

| Rủi ro | Mức | Biện pháp |
|---|---|---|
| LLM sinh code sai/thiếu | Cao | Test + review diff + quality loop; không auto-merge |
| Prompt injection từ nội dung repo | Trung bình | Prompt quy tắc; policy tool; con người review; không sandbox OS |
| Agent đọc secret | Cao | Protected paths + redaction; deny mặc định |
| Agent chạy lệnh phá hoại | Cao | Allowlist + deny pattern + approval; không commit/push |
| Tốn token/chi phí | Trung bình | maxSteps, maxAttempts, maxCycles, timeout; usage trong report |
| Test không phản ánh đúng | Trung bình | Evidence bắt buộc; engine tự đánh giá; chạy test thủ công trước merge |
| State hỏng khi process chết | Thấp | Atomic write; resume từ state gần nhất; transcript append |
| Plan heuristic kém | Trung bình | Cảnh báo rõ trong report; review kỹ |
| Windows path/encoding | Thấp | `path`, UTF-8, test trên Windows |

---

## 9. Known gaps (đối chiếu mục tiêu ban đầu)

| Mục tiêu | Trạng thái | Ghi chú |
|---|---|---|
| 4 agent phối hợp | Đạt | backend/frontend/testing/debug |
| Orchestrator quản lý task/dependency | Đạt | DAG + scheduler song song theo role |
| Approval gate | Đạt | gate/auto/deny + CLI/dashboard approve/reject |
| Vòng test/debug | Đạt | maxFixCycles, evidence |
| Báo cáo Markdown/JSON | Đạt | report.md + summary.json + agents/<role>.md |
| Chạy thật trên backend/frontend | Một phần | Đã smoke mock; live cần API key + môi trường Java |
| Song song | Đạt một phần | Mặc định tuần tự để tránh xung đột; có thể bật song song theo `maxParallel`, chưa worktree/merge |
| Dashboard realtime | Đạt | SSE + local server, không auth |
| Sandbox OS | Chưa | Policy mức ứng dụng |
| Tự commit/push | Không làm (đúng yêu cầu) | Review thủ công |

---

## 10. Truy vết yêu cầu → code → test

| Yêu cầu | Code | Test |
|---|---|---|
| FR-01 Planner | `agents/planner.ts`, `core/plan.ts` | `plan.test.ts` |
| FR-02 Scheduler | `core/engine.ts`, `core/plan.ts` | `engine.test.ts`, `plan.test.ts` |
| FR-03 Agent loop | `agents/base.ts` | `tools.test.ts`, `engine.test.ts` |
| FR-04 Testing | `core/engine.ts`, `tools/test-tools.ts` | `engine.test.ts` |
| FR-05 Evidence | `core/engine.ts` | `engine.test.ts` |
| FR-06 Debug loop | `core/engine.ts` | `engine.test.ts` |
| FR-07 Approval | `core/approvals.ts`, `core/policy.ts` | `tools.test.ts`, `engine.test.ts` |
| FR-08 Resume | `core/state.ts`, `core/engine.ts` | `state.test.ts`, `engine.test.ts` |
| FR-09 Report | `core/reporter.ts` | `engine.test.ts`, `server.test.ts` |
| FR-10 Bus | `core/bus.ts`, `tools/team-tools.ts` | `tools.test.ts` |
| FR-11 Tools | `tools/*`, `core/policy.ts` | `policy.test.ts`, `tools.test.ts` |
| FR-12 CLI | `cli.ts` | Smoke test |
| FR-13 Config | `config.ts`, `agent.config.json` | `policy.test.ts`, `tools.test.ts` |
| FR-14 Secret | `config.ts`, `util/text.ts`, `util/logger.ts` | `tools.test.ts` |
| FR-15 Dashboard realtime | `server.ts`, `core/reporter.ts` | `server.test.ts` |

---

## 11. Lệnh kiểm chứng

```powershell
cd orchestrator

# 1. Chất lượng mã
npm run typecheck
npm run build

# 2. Test tự động (31)
npm test

# 3. Môi trường
npm run agent -- doctor

# 4. Smoke pipeline, không cần key
npm run agent -- run "Thêm API nhà cung cấp" --mock --no-interactive
npm run agent -- status latest
npm run agent -- report latest --print
npm run agent -- serve latest --port 4317

# 5. Live (cần LLM_API_KEY)
npm run agent -- run "Thêm API nhà cung cấp" --yes
```

---

## 12. Tài liệu liên quan

- [README](../README.md) — cài đặt, CLI, cấu hình, troubleshooting.
- [ARCHITECTURE](ARCHITECTURE.md) — thiết kế chi tiết, state machine, scheduler.
- [SECURITY](SECURITY.md) — threat model, kiểm soát, khuyến nghị.
