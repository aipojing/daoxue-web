import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import CoursewareCreatePanel from "../components/CoursewareCreatePanel";
import CoursewareGenerationStatus from "../components/CoursewareGenerationStatus";
import { apiDelete, apiGet, ApiError } from "../api";
import { useDialogFocus } from "../lib/modal";
import {
  CoursewareItemsCoordinator,
  CoursewareOperationGuard,
  CoursewarePollChain,
  CoursewareRequestEpoch,
  applyPollingUpdates,
  mergeCoursewarePage,
  shouldPollCourseware,
  updateCoursewareList,
} from "../lib/courseware";
import type { CoursewareAISettings } from "../../shared/ai-catalog";
import type { CoursewareSummary } from "../../shared/courseware";
import type { StudentWorkspaceContext } from "../components/StudentWorkspaceLayout";

interface CoursewarePageResponse {
  items: CoursewareSummary[];
  nextCursor: string | null;
}
function statusLabel(item: CoursewareSummary) {
  if (item.status === "ready") {
    return item.generationStage === "images" ? "正在补充配图" : "可以上课";
  }
  if (item.status === "failed") return item.retryable ? "需要重新生成" : "生成未完成";
  if (item.status === "deleting") return "正在删除";
  return "正在生成";
}

function CoursewareDeleteModal({
  courseware,
  onClose,
  onConfirm,
}: {
  courseware: CoursewareSummary;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useDialogFocus<HTMLFormElement>(() => {
    if (!pending) onClose();
  });
  const matches = typed.trim() === courseware.title.trim();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches || pending) return;
    setPending(true);
    try {
      await onConfirm();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "删除失败，请重试");
      setPending(false);
    }
  };
  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!pending) onClose();
      }}
    >
      <form
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="courseware-delete-title"
        aria-describedby="courseware-delete-description"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => void submit(event)}
      >
        <h2 id="courseware-delete-title" className="modal-title">
          删除课件
        </h2>
        <p id="courseware-delete-description">
          删除「{courseware.title}
          」会移除这节课件及其已保存的语音和配图媒体，且无法恢复。
        </p>
        <label className="form-label">
          输入课件名称以确认
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            disabled={pending}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!matches || pending}
          >
            {pending ? "删除中…" : "确认删除"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function CoursewaresPage() {
  const { studentId: rawId } = useParams();
  const { student } = useOutletContext<StudentWorkspaceContext>();
  const studentId = Number(rawId);
  const [settings, setSettings] = useState<CoursewareAISettings | null>(null);
  const [items, setItems] = useState<CoursewareSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<CoursewareSummary | null>(
    null,
  );
  const [routeToken, setRouteToken] = useState(0);
  const [routeSignal, setRouteSignal] = useState<AbortSignal>(
    () => new AbortController().signal,
  );
  const routeRef = useRef(new CoursewareRequestEpoch());
  const operationsRef = useRef(new CoursewareOperationGuard());
  const controllersRef = useRef(new Set<AbortController>());
  const routeAbortRef = useRef(new AbortController());
  const deletedRef = useRef(new Set<number>());
  const itemsRef = useRef(items);
  const pollRef = useRef<() => Promise<void>>(async () => {});
  const chainRef = useRef<CoursewarePollChain | null>(null);
  const coordinatorRef = useRef(
    new CoursewareItemsCoordinator(() => chainRef.current?.wake()),
  );
  itemsRef.current = items;
  const isRouteCurrent = useCallback(
    (token: number) => routeRef.current.isCurrent(token),
    [],
  );
  const commitItems = useCallback(
    (next: CoursewareSummary[], wakeOnTransition = true) => {
      coordinatorRef.current.commit(next, wakeOnTransition);
      itemsRef.current = next;
      setItems(next);
    },
    [],
  );
  const get = useCallback(
    async <T,>(
      path: string,
      routeTokenValue: number,
      operation?: string,
    ): Promise<T | null> => {
      const controller = new AbortController();
      controllersRef.current.add(controller);
      const operationToken = operation
        ? operationsRef.current.begin(operation)
        : 0;
      try {
        const data = await apiGet<T>(path, { signal: controller.signal });
        return !controller.signal.aborted &&
          routeRef.current.isCurrent(routeTokenValue) &&
          (!operation ||
            operationsRef.current.isCurrent(operation, operationToken))
          ? data
          : null;
      } finally {
        controllersRef.current.delete(controller);
      }
    },
    [],
  );
  pollRef.current = async () => {
    const token = routeRef.current.capture();
    const active = itemsRef.current.filter((item) =>
      shouldPollCourseware(item),
    );
    if (!active.length) return;
    const updates = await Promise.all(
      active.map((item) =>
        get<CoursewareSummary>(`/api/coursewares/${item.id}`, token).catch(
          () => null,
        ),
      ),
    );
    if (routeRef.current.isCurrent(token))
      commitItems(
        applyPollingUpdates(itemsRef.current, updates, deletedRef.current),
        false,
      );
  };
  useEffect(() => {
    const chain = new CoursewarePollChain(
      {
        setTimeout: (callback, delay) => window.setTimeout(callback, delay),
        clearTimeout: (id) => window.clearTimeout(id),
      },
      () => itemsRef.current.some((item) => shouldPollCourseware(item)),
      () => pollRef.current(),
    );
    chainRef.current = chain;
    chain.start();
    const focus = () => chain.resetForFocus();
    window.addEventListener("focus", focus);
    return () => {
      window.removeEventListener("focus", focus);
      chain.stop();
      chainRef.current = null;
    };
  }, []);
  useEffect(() => {
    controllersRef.current.forEach((controller) => controller.abort());
    routeAbortRef.current.abort();
    routeAbortRef.current = new AbortController();
    operationsRef.current.dispose();
    deletedRef.current.clear();
    const token = routeRef.current.begin();
    setRouteToken(token);
    setRouteSignal(routeAbortRef.current.signal);
    setSettings(null);
    commitItems([]);
    setNextCursor(null);
    setError("");
    setDeleteTarget(null);
    setLoadingMore(false);
    setLoading(true);
    if (!Number.isSafeInteger(studentId) || studentId < 1) {
      setError("学生地址无效，请返回学生列表后重试");
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const [loadedSettings, page] = await Promise.all([
          get<CoursewareAISettings>("/api/courseware-ai-settings", token),
          get<CoursewarePageResponse>(
            `/api/students/${studentId}/coursewares?limit=20`,
            token,
          ),
        ]);
        if (!routeRef.current.isCurrent(token) || !loadedSettings || !page)
          return;
        setSettings(loadedSettings);
        commitItems(page.items);
        setNextCursor(page.nextCursor);
      } catch (cause) {
        if (routeRef.current.isCurrent(token))
          setError(
            cause instanceof ApiError ? cause.message : "无法加载课件库",
          );
      } finally {
        if (routeRef.current.isCurrent(token)) setLoading(false);
      }
    })();
    return () => {
      routeRef.current.dispose();
      routeAbortRef.current.abort();
      controllersRef.current.forEach((controller) => controller.abort());
    };
  }, [commitItems, get, studentId]);
  const refreshItem = useCallback(
    async (id: number) => {
      const token = routeRef.current.capture();
      const next = await get<CoursewareSummary>(
        `/api/coursewares/${id}`,
        token,
        `refresh:${id}`,
      ).catch(() => null);
      if (next && !deletedRef.current.has(id))
        commitItems(updateCoursewareList(itemsRef.current, next));
    },
    [commitItems, get],
  );
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const token = routeRef.current.capture();
    setLoadingMore(true);
    try {
      const page = await get<CoursewarePageResponse>(
        `/api/students/${studentId}/coursewares?limit=20&cursor=${encodeURIComponent(nextCursor)}`,
        token,
        "load-more",
      );
      if (page) {
        commitItems(
          mergeCoursewarePage(
            itemsRef.current.filter((item) => !deletedRef.current.has(item.id)),
            page.items.filter((item) => !deletedRef.current.has(item.id)),
          ),
        );
        setNextCursor(page.nextCursor);
      }
    } catch (cause) {
      if (routeRef.current.isCurrent(token))
        setError(
          cause instanceof ApiError ? cause.message : "加载更多课件失败",
        );
    } finally {
      if (routeRef.current.isCurrent(token)) setLoadingMore(false);
    }
  };
  const remove = async (courseware: CoursewareSummary) => {
    const token = routeRef.current.capture();
    const operation = `delete:${courseware.id}`;
    const operationToken = operationsRef.current.begin(operation);
    const controller = new AbortController();
    controllersRef.current.add(controller);
    try {
      await apiDelete(`/api/coursewares/${courseware.id}`, {
        signal: controller.signal,
      });
      if (
        !routeRef.current.isCurrent(token) ||
        !operationsRef.current.isCurrent(operation, operationToken) ||
        controller.signal.aborted
      )
        return;
      deletedRef.current.add(courseware.id);
      commitItems(itemsRef.current.filter((item) => item.id !== courseware.id));
      setDeleteTarget(null);
    } finally {
      controllersRef.current.delete(controller);
    }
  };
  if (loading)
    return (
      <div className="page courseware-page">
        <div className="courseware-loading" aria-live="polite">
          正在加载课件库…
        </div>
      </div>
    );
  if (error && !settings)
    return (
      <div className="page courseware-page">
        <div className="courseware-error-state" role="alert">
          <p>{error}</p>
          <button
            className="btn btn-primary"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </div>
      </div>
    );
  if (!settings) return null;
  return (
    <div className="page courseware-page">
      <header className="courseware-hero">
        <p className="courseware-eyebrow">{student.name}的语音课件</p>
        <h1>把难点讲成一段可跟读的课</h1>
        <p>课件会在后台生成，准备完成后可以从这里继续学习。</p>
      </header>
      <CoursewareCreatePanel
        key={studentId}
        studentId={studentId}
        settings={settings}
        routeToken={routeToken}
        routeSignal={routeSignal}
        isRouteCurrent={isRouteCurrent}
        onCreated={(created) => {
          if (isRouteCurrent(routeToken)) {
            commitItems([
              created,
              ...itemsRef.current.filter((item) => item.id !== created.id),
            ]);
            chainRef.current?.wake();
          }
        }}
      />
      <section
        className="courseware-library"
        aria-labelledby="courseware-library-title"
      >
        <div className="courseware-library-heading">
          <div>
            <p className="courseware-eyebrow">课件库</p>
            <h2 id="courseware-library-title">已经准备的学习内容</h2>
          </div>
          {error && (
            <p className="courseware-inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
        {items.length === 0 ? (
          <div className="courseware-empty">
            <h3>还没有语音课件</h3>
            <p>填写上方内容后，就能为孩子准备第一节课。</p>
          </div>
        ) : (
          <div className="courseware-list">
            {items.map((item) => (
              <article
                id={`courseware-${item.id}`}
                className={`courseware-card is-${item.status}`}
                key={item.id}
              >
                <div className="courseware-card-head">
                  <div>
                    <p className="courseware-subject">{item.subject}</p>
                    <h3>{item.title}</h3>
                    <p>{item.topic}</p>
                  </div>
                  <span className="courseware-badge">{statusLabel(item)}</span>
                </div>
                <CoursewareGenerationStatus
                  courseware={item}
                  routeToken={routeToken}
                  routeSignal={routeSignal}
                  isRouteCurrent={isRouteCurrent}
                  onQueued={() => void refreshItem(item.id)}
                />
                <div className="courseware-card-actions">
                  {item.status === "ready" && (
                    <Link
                      className="btn btn-primary"
                      to={`/students/${studentId}/coursewares/${item.id}`}
                    >
                      继续上课
                    </Link>
                  )}
                  {shouldPollCourseware(item) && (
                    <a className="btn" href={`#courseware-${item.id}`}>
                      查看进度
                    </a>
                  )}
                  <button
                    type="button"
                    className="courseware-delete-button"
                    disabled={item.status === "deleting"}
                    onClick={() => setDeleteTarget(item)}
                  >
                    {item.status === "deleting" ? "正在删除" : "删除"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {nextCursor && (
          <div className="courseware-load-more">
            <button
              className="btn"
              type="button"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "正在加载…" : "加载更多"}
            </button>
          </div>
        )}
      </section>
      {deleteTarget && (
        <CoursewareDeleteModal
          courseware={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => remove(deleteTarget)}
        />
      )}
    </div>
  );
}
