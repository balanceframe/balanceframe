# Optional image only. The core Dockerfile never compiles or installs OCR.
FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl build-essential cmake pkg-config libpng-dev libjpeg62-turbo-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/sources
RUN curl --fail --location --proto '=https' --tlsv1.2 https://codeload.github.com/DanBloomberg/leptonica/tar.gz/refs/tags/1.87.0 -o leptonica.tar.gz \
    && echo 'fa2b40c5caea96d1bb93a97486262aed8731b69ce25a84a6bf5d25323e33f631  leptonica.tar.gz' | sha256sum --check - \
    && tar -xzf leptonica.tar.gz \
    && cmake -S leptonica-1.87.0 -B lept-build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/ocr -DCMAKE_INSTALL_LIBDIR=lib \
       -DBUILD_SHARED_LIBS=ON -DBUILD_PROG=OFF -DENABLE_GIF=OFF -DENABLE_TIFF=OFF -DENABLE_WEBP=OFF -DENABLE_OPENJPEG=OFF \
    && cmake --build lept-build --parallel 2 && cmake --install lept-build \
    && install -Dm644 leptonica-1.87.0/leptonica-license.txt /opt/ocr/licenses/leptonica-LICENSE
RUN curl --fail --location --proto '=https' --tlsv1.2 https://codeload.github.com/tesseract-ocr/tesseract/tar.gz/refs/tags/5.5.3 -o tesseract.tar.gz \
    && echo '9218e62793116d42a9f6d14cd9348518b27f382096eea3d0f2d1a24616bb5884  tesseract.tar.gz' | sha256sum --check - \
    && tar -xzf tesseract.tar.gz \
    && cmake -S tesseract-5.5.3 -B tess-build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/ocr -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_PREFIX_PATH=/opt/ocr \
       -DBUILD_SHARED_LIBS=ON -DBUILD_TRAINING_TOOLS=OFF -DBUILD_TESTS=OFF -DGRAPHICS_DISABLED=ON -DDISABLED_LEGACY_ENGINE=ON \
       -DDISABLE_ARCHIVE=ON -DDISABLE_CURL=ON -DDISABLE_TIFF=ON -DOPENMP_BUILD=OFF -DENABLE_NATIVE=OFF \
    && cmake --build tess-build --parallel 2 && cmake --install tess-build \
    && install -Dm644 tesseract-5.5.3/LICENSE /opt/ocr/licenses/tesseract-LICENSE
RUN mkdir -p /opt/ocr/share/tessdata \
    && curl --fail --location --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata -o /opt/ocr/share/tessdata/eng.traineddata \
    && echo '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2  /opt/ocr/share/tessdata/eng.traineddata' | sha256sum --check - \
    && printf '4.1.0\n' > /opt/ocr/share/tessdata/MODEL_VERSION \
    && curl --fail --location --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/LICENSE -o /opt/ocr/licenses/tessdata-fast-LICENSE \
    && echo 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30  /opt/ocr/licenses/tessdata-fast-LICENSE' | sha256sum --check -

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libpng16-16 libjpeg62-turbo zlib1g \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/ocr /opt/ocr
WORKDIR /app
COPY packages/receipt-ocr/src/ ./src/
COPY packages/receipt-ocr/THIRD_PARTY_OCR.txt ./THIRD_PARTY_OCR.txt
ENV LD_LIBRARY_PATH=/opt/ocr/lib NODE_ENV=production
RUN node --input-type=module -e 'import {verifyRuntime} from "./src/extract.mjs";await verifyRuntime()'
USER node
EXPOSE 8088
CMD ["node", "src/cli.mjs"]
LABEL org.opencontainers.image.title="BalanceFrame optional receipt OCR" \
      org.opencontainers.image.licenses="Apache-2.0 AND BSD-2-Clause"
