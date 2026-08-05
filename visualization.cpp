// visualization.cpp

#include <emscripten.h>
#include <emscripten/html5.h>
#include <GLES2/gl2.h>

#include <algorithm>
#include <cmath>
#include <iostream>
#include <limits>
#include <string>
#include <unordered_map>
#include <vector>

#include <json/json.h>

struct Node {
    std::string id;
    std::string group;
    std::string text;
    float rawX = 0.0f;
    float rawY = 0.0f;
    float rawZ = 0.0f;
    float x = 0.0f;
    float y = 0.0f;
    float z = 0.0f;
};

struct LinkRef {
    std::string sourceId;
    std::string targetId;
};

static std::vector<Node> nodes;
static std::vector<LinkRef> links;
static std::vector<GLfloat> pointVertices;
static std::vector<GLfloat> lineVertices;
static GLuint program = 0;
static GLuint pointsVbo = 0;
static GLuint linesVbo = 0;
static GLint positionAttrib = -1;
static GLint colorUniform = -1;

static std::string parseLinkEndpoint(const Json::Value& endpoint) {
    if (endpoint.isString()) {
        return endpoint.asString();
    }

    if (endpoint.isObject()) {
        if (endpoint["id"].isString()) return endpoint["id"].asString();
        if (endpoint["name"].isString()) return endpoint["name"].asString();
        if (endpoint["reference"].isString()) return endpoint["reference"].asString();
    }

    return "";
}

static void normalizeNodeCoordinates() {
    if (nodes.empty()) {
        return;
    }

    float minX = std::numeric_limits<float>::max();
    float maxX = std::numeric_limits<float>::lowest();
    float minY = std::numeric_limits<float>::max();
    float maxY = std::numeric_limits<float>::lowest();

    for (const auto& node : nodes) {
        minX = std::min(minX, node.rawX);
        maxX = std::max(maxX, node.rawX);
        minY = std::min(minY, node.rawY);
        maxY = std::max(maxY, node.rawY);
    }

    const float spanX = (maxX - minX == 0.0f) ? 1.0f : (maxX - minX);
    const float spanY = (maxY - minY == 0.0f) ? 1.0f : (maxY - minY);
    const float pad = 0.92f;

    for (auto& node : nodes) {
        const float nx = (node.rawX - minX) / spanX;
        const float ny = (node.rawY - minY) / spanY;
        node.x = -pad + (2.0f * pad * nx);
        node.y = -pad + (2.0f * pad * ny);
        node.z = node.rawZ;
    }
}

static void rebuildPointVertices() {
    pointVertices.clear();
    pointVertices.reserve(nodes.size() * 3);

    for (const auto& node : nodes) {
        pointVertices.push_back(node.x);
        pointVertices.push_back(node.y);
        pointVertices.push_back(node.z);
    }

    glBindBuffer(GL_ARRAY_BUFFER, pointsVbo);
    glBufferData(GL_ARRAY_BUFFER, pointVertices.size() * sizeof(GLfloat), pointVertices.data(), GL_STATIC_DRAW);
}

static void rebuildLineVertices() {
    std::unordered_map<std::string, std::size_t> nodeIndexById;
    nodeIndexById.reserve(nodes.size());
    for (std::size_t i = 0; i < nodes.size(); ++i) {
        nodeIndexById[nodes[i].id] = i;
    }

    lineVertices.clear();
    lineVertices.reserve(links.size() * 6);

    for (const auto& link : links) {
        auto sourceIt = nodeIndexById.find(link.sourceId);
        auto targetIt = nodeIndexById.find(link.targetId);
        if (sourceIt == nodeIndexById.end() || targetIt == nodeIndexById.end()) {
            continue;
        }

        const auto& source = nodes[sourceIt->second];
        const auto& target = nodes[targetIt->second];

        lineVertices.push_back(source.x);
        lineVertices.push_back(source.y);
        lineVertices.push_back(source.z);

        lineVertices.push_back(target.x);
        lineVertices.push_back(target.y);
        lineVertices.push_back(target.z);
    }

    glBindBuffer(GL_ARRAY_BUFFER, linesVbo);
    glBufferData(GL_ARRAY_BUFFER, lineVertices.size() * sizeof(GLfloat), lineVertices.data(), GL_STATIC_DRAW);
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
void initialize() {
    const char* vertexShaderSource = R"(
        attribute vec3 position;
        void main() {
            gl_Position = vec4(position, 1.0);
            gl_PointSize = 3.0;
        }
    )";

    const char* fragmentShaderSource = R"(
        precision mediump float;
        uniform vec4 uColor;
        void main() {
            gl_FragColor = uColor;
        }
    )";

    GLuint vertexShader = glCreateShader(GL_VERTEX_SHADER);
    glShaderSource(vertexShader, 1, &vertexShaderSource, nullptr);
    glCompileShader(vertexShader);

    GLuint fragmentShader = glCreateShader(GL_FRAGMENT_SHADER);
    glShaderSource(fragmentShader, 1, &fragmentShaderSource, nullptr);
    glCompileShader(fragmentShader);

    program = glCreateProgram();
    glAttachShader(program, vertexShader);
    glAttachShader(program, fragmentShader);
    glLinkProgram(program);

    glDeleteShader(vertexShader);
    glDeleteShader(fragmentShader);

    glGenBuffers(1, &pointsVbo);
    glGenBuffers(1, &linesVbo);

    positionAttrib = glGetAttribLocation(program, "position");
    colorUniform = glGetUniformLocation(program, "uColor");

    glClearColor(1.0f, 1.0f, 1.0f, 1.0f);
}

EMSCRIPTEN_KEEPALIVE
void setNodesData(const char* jsonData) {
    Json::Value root;
    Json::Reader reader;
    if (!reader.parse(jsonData, root) || !root.isArray()) {
        std::cerr << "Failed to parse nodes JSON data" << std::endl;
        return;
    }

    nodes.clear();
    nodes.reserve(root.size());

    for (const auto& nodeValue : root) {
        Node node;
        node.id = nodeValue.get("id", "").asString();
        node.group = nodeValue.get("group", "").asString();
        node.text = nodeValue.get("text", "").asString();
        node.rawX = nodeValue.get("x", 0.0).asFloat();
        node.rawY = nodeValue.get("y", 0.0).asFloat();
        node.rawZ = nodeValue.get("z", 0.0).asFloat();
        nodes.push_back(node);
    }

    normalizeNodeCoordinates();
    rebuildPointVertices();
    rebuildLineVertices();
}

EMSCRIPTEN_KEEPALIVE
void setLinksData(const char* jsonData) {
    Json::Value root;
    Json::Reader reader;
    if (!reader.parse(jsonData, root) || !root.isArray()) {
        std::cerr << "Failed to parse links JSON data" << std::endl;
        return;
    }

    links.clear();
    links.reserve(root.size());

    for (const auto& linkValue : root) {
        LinkRef link;
        link.sourceId = parseLinkEndpoint(linkValue["source"]);
        link.targetId = parseLinkEndpoint(linkValue["target"]);
        if (!link.sourceId.empty() && !link.targetId.empty()) {
            links.push_back(link);
        }
    }

    rebuildLineVertices();
}

// Backward-compatible alias for existing JS callers.
EMSCRIPTEN_KEEPALIVE
void setData(const char* jsonData) {
    setNodesData(jsonData);
}

EMSCRIPTEN_KEEPALIVE
void render() {
    glClear(GL_COLOR_BUFFER_BIT);
    glUseProgram(program);

    glEnableVertexAttribArray(positionAttrib);

    if (!lineVertices.empty()) {
        glBindBuffer(GL_ARRAY_BUFFER, linesVbo);
        glVertexAttribPointer(positionAttrib, 3, GL_FLOAT, GL_FALSE, 0, 0);
        glUniform4f(colorUniform, 0.60f, 0.60f, 0.60f, 0.45f);
        glDrawArrays(GL_LINES, 0, lineVertices.size() / 3);
    }

    if (!pointVertices.empty()) {
        glBindBuffer(GL_ARRAY_BUFFER, pointsVbo);
        glVertexAttribPointer(positionAttrib, 3, GL_FLOAT, GL_FALSE, 0, 0);
        glUniform4f(colorUniform, 0.12f, 0.45f, 0.78f, 1.0f);
        glDrawArrays(GL_POINTS, 0, pointVertices.size() / 3);
    }

    glDisableVertexAttribArray(positionAttrib);
}

EMSCRIPTEN_KEEPALIVE
void onMouseClick(int x, int y) {
    int canvasWidth = 1;
    int canvasHeight = 1;
    emscripten_get_canvas_element_size("#graph-canvas", &canvasWidth, &canvasHeight);

    const float glX = (2.0f * static_cast<float>(x) / static_cast<float>(canvasWidth)) - 1.0f;
    const float glY = 1.0f - (2.0f * static_cast<float>(y) / static_cast<float>(canvasHeight));

    float minDistance = std::numeric_limits<float>::max();
    const Node* closestNode = nullptr;
    for (const auto& node : nodes) {
        const float dx = node.x - glX;
        const float dy = node.y - glY;
        const float distance = std::sqrt(dx * dx + dy * dy);
        if (distance < minDistance) {
            minDistance = distance;
            closestNode = &node;
        }
    }

    const float clickThreshold = 0.06f;
    if (closestNode && minDistance <= clickThreshold) {
        EM_ASM({
            if (Module && typeof Module.onNodeClick === 'function') {
                Module.onNodeClick(UTF8ToString($0));
            }
        }, closestNode->id.c_str());
    }
}

}  // extern "C"

void main_loop() {
    render();
}

int main() {
    initialize();
    emscripten_set_main_loop(main_loop, 0, 1);
    return 0;
}