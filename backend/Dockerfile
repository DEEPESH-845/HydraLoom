# GANTRYLAB evaluation backend (gantrylab.app). One process only: run state and progress live in memory.
#   docker build -t gantrylab-backend backend
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 GANTRYLAB_DATA_DIR=/data YOLO_CONFIG_DIR=/tmp/yolo YOLO_OFFLINE=True YOLO_AUTOINSTALL=False

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 gantry \
    && install -d -o gantry -g gantry /data

WORKDIR /app
COPY requirements-gantrylab.txt ./
RUN pip install --no-cache-dir torch==2.11.0 torchvision==0.26.0 --index-url https://download.pytorch.org/whl/cpu \
    && grep -vE '^(pytest|httpx2)' requirements-gantrylab.txt > /tmp/req.txt \
    && pip install --no-cache-dir -r /tmp/req.txt && rm /tmp/req.txt
COPY gantrylab ./gantrylab

USER gantry
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=4)"]
CMD ["uvicorn", "gantrylab.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
