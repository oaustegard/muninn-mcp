# Muninn MCP on FastMCP 4 — container image for Cloudflare Containers.
#
# NOT A WORKER, AND THAT IS THE POINT. `remembering/scripts` imports `requests`
# at module load, which is unavailable under Pyodide, so Python Workers are out.
# Cloudflare Containers (GA April 2026) run an ordinary Dockerfile, which is the
# same conclusion Sage reached for its Go app — see `sage/sage-container/`.
#
# UNDEPLOYED. This builds the shape the decision implies; nothing has run it on
# Cloudflare yet. Treat the runtime characteristics as unmeasured.
FROM python:3.12-slim

# Blue is fetched, not vendored: it must be the SAME code the skill runs, and a
# copy in this repo would be a second implementation by the back door — exactly
# what §5 Stage 5 says the migration exists to avoid. Pin the ref explicitly so
# a rebuild is reproducible; `main` here would make the container's behaviour
# depend on when it was built.
ARG MUNINN_UTILS_REF=main
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --pre -r requirements.txt

RUN git clone --depth 1 --branch "${MUNINN_UTILS_REF}" \
        https://github.com/oaustegard/muninn-utilities /opt/muninn-utilities
ENV MUNINN_SCRIPTS=/opt/muninn-utilities/remembering/scripts

COPY server.py .

# Stamps every write as this deployment (§5 Stage 0). No write tool exists yet;
# setting it here means the first one added is attributable on day one.
ENV MUNINN_WRITE_SOURCE=mcp-fastmcp@0.1.0
ENV PORT=8080
EXPOSE 8080

# TURSO_URL / TURSO_TOKEN are injected at runtime, never baked into the image.
CMD ["python", "server.py"]
