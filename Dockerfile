# Use the official Emscripten Docker image
FROM emscripten/emsdk:latest

# Install necessary packages
RUN apt-get update && apt-get install -y \
    git \
    cmake \
    build-essential

# Set the working directory
WORKDIR /project

# Clone the jsoncpp repository into the project directory
RUN git clone https://github.com/open-source-parsers/jsoncpp.git /project/jsoncpp

# Copy the project files into the container
COPY . /project

# Compile jsoncpp source files
RUN emcc -c /project/jsoncpp/src/lib_json/*.cpp -I/project/jsoncpp/include

# Build the project
RUN emcc visualization.cpp *.o -I/project/jsoncpp/include -o visualization.js -s EXPORTED_FUNCTIONS='["_initialize", "_setData", "_render", "_onMouseClick"]' -s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap"]' -s MODULARIZE=1 -s ENVIRONMENT=web

# Copy the output files to the host machine's scripture-scope/src directory
RUN mkdir -p /output && cp /project/visualization.js /project/visualization.wasm /output/