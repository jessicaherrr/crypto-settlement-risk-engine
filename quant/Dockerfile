FROM python:3.12-slim AS build
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir ".[service]"

FROM python:3.12-slim
WORKDIR /app
COPY --from=build /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=build /usr/local/bin /usr/local/bin
COPY src ./src
ENV PYTHONPATH=/app/src
# RISK_ORACLE_PRIVATE_KEY is read from the container's environment at
# startup (docker-compose.yml passes it through from the host) - never
# baked into this image.
EXPOSE 8001
CMD ["uvicorn", "askgene_quant.service.app:app", "--host", "0.0.0.0", "--port", "8001"]
