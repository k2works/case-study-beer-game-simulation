# 本番用イメージ（マルチステージ）。設計: docs/design/beer-game-kotlin/architecture-infrastructure.md「コンテナと JVM」
# ビルド: docker build --build-context web=apps/beer-game-web -t beer-game-kotlin apps/beer-game-kotlin（web は Rust 版と共有する apps/beer-game-web。docker 23 以上）
# 起動:   docker run ... beer-game-kotlin [api|migrate|retention|rebuild-projections|verify-projections]（既定 api）
#         retention は保持削除の掃引を 1 回行って終了する（B11。終了コード 0、放棄したゲームがあれば 1）。
#         rebuild-projections [ゲーム ID ...] は投影をイベントから作り直す（B12。省くと全ゲーム。終了コード 0、失敗したゲームがあれば 1）。
#         verify-projections は投影の整合を検査する（B12。日次。終了コード 0、不一致があれば 1）。

# ---- ビルド: JDK 25 で Gradle の installDist ----
FROM eclipse-temurin:25-jdk-noble AS build
WORKDIR /src
COPY . .
# H2 のドライバは配布に含めない（app/build.gradle.kts の startScripts と distributions で除外）。
# デモ環境だけが使う H2 は、別に build/demo-lib へ写す（demo ステージが取り込む。本番の runtime には入れない）。
RUN ./gradlew --no-daemon :app:installDist :app:copyDemoLibs \
    && mkdir -p /out/deps /out/app \
    && cd app/build/install/app/lib \
    && for jar in app.jar application.jar domain.jar adapter-http.jar adapter-persistence.jar; do mv "$jar" /out/app/; done \
    && mv ./*.jar /out/deps/ \
    && cp -r ../bin /out/bin

# ---- 画面: React/Vite のビルド成果物（デモ環境の demo ステージだけが使う）----
FROM node:24-bookworm-slim AS webbuild
WORKDIR /web
# web は apps/beer-game-web（Rust 版と共有）にあるので、名前付きのビルドコンテキスト「web」から取り込む（BuildKit。docker 23 以上）。
COPY --from=web package.json package-lock.json ./
RUN npm ci
COPY --from=web . ./
RUN npm run build

# ---- 共通: JRE 25 と、ビルド済みの成果物だけ（runtime と demo の土台）----
FROM eclipse-temurin:25-jre-noble AS base
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
WORKDIR /app
# 依存の JAR（変更が少ない）とアプリの JAR（変更が多い）を別の層にする。
COPY --from=build /out/bin ./bin
COPY --from=build /out/deps ./lib
COPY --from=build /out/app ./lib

# ---- デモ: 共通の土台に、H2 と画面を足す（Heroku のデモ環境。docs/operation/beer-game-kotlin/demo.md）----
# H2 のインメモリ（APP_ENV=local のときだけ許される。ADR-014）で動き、再起動で初期状態に戻る。画面は API と同じ URL から配信する。
# 配布の起動スクリプトは H2 を外したクラスパスなので、java で直接起動する。ヒープは JAVA_TOOL_OPTIONS（Config Vars）で 512 MB に収める。
# 実行ユーザーは Heroku が決めるので、USER は指定しない。ビルドは `--target demo`（既定は、下の本番用の runtime）。
FROM base AS demo
COPY --from=build /src/app/build/demo-lib ./demo-lib
COPY --from=webbuild /web/dist ./web
ENV APP_ENV=local DB_KIND=h2 HOST=0.0.0.0 WEB_ROOT=/app/web
ENTRYPOINT ["java", "-cp", "/app/lib/*:/app/demo-lib/*", "beergame.app.MainKt"]
CMD ["api"]

# ---- 本番用（既定のターゲット。最後のステージ）----
FROM base AS runtime
# ヒープはコンテナのメモリの割合で指定し（初期案 70%。測定で決める）、メモリ不足ではプロセスを終了させる。
ENV JAVA_OPTS="-XX:MaxRAMPercentage=70 -XX:+ExitOnOutOfMemoryError"
USER app
EXPOSE 8080
# /api/v1/ready が 200 のときだけ healthy。curl・wget は実行イメージに無いので、bash の /dev/tcp で HTTP を送る。
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
    CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${PORT:-8080} && printf 'GET /api/v1/ready HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3 && head -n1 <&3 | grep -q ' 200 '"]
ENTRYPOINT ["/app/bin/app"]
CMD ["api"]
