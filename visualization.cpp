// visualization.cpp

#include <emscripten.h>
#include <emscripten/html5.h>
#include <GLES2/gl2.h>
#include <vector>
#include <string>
#include <iostream>
#include <cmath>
#include <json/json.h>

// Data structure to hold node information
struct Node {
    float x, y, z;
    std::string id;
    // Additional attributes
};

std::vector<Node> nodes;
GLuint program;
GLuint vbo;

extern "C" {

EMSCRIPTEN_KEEPALIVE
void initialize() {
    // Initialize OpenGL context and other settings
    glEnable(GL_DEPTH_TEST);
    glDepthFunc(GL_LEQUAL);

    // Create and compile shaders, link program, etc.
    const char* vertexShaderSource = R"(
        attribute vec3 position;
        void main() {
            gl_Position = vec4(position, 1.0);
            gl_PointSize = 5.0;
        }
    )";

    const char* fragmentShaderSource = R"(
        void main() {
            gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
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

    glGenBuffers(1, &vbo);
}

EMSCRIPTEN_KEEPALIVE
void setData(const char* jsonData) {
    // Parse JSON data and populate 'nodes' vector
    Json::Value root;
    Json::Reader reader;
    if (!reader.parse(jsonData, root)) {
        std::cerr << "Failed to parse JSON data" << std::endl;
        return;
    }

    nodes.clear();
    for (const auto& node : root) {
        Node n;
        n.x = node["x"].asFloat();
        n.y = node["y"].asFloat();
        n.z = node["z"].asFloat();
        n.id = node["id"].asString();
        nodes.push_back(n);
    }

    // Update VBO with new data
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBufferData(GL_ARRAY_BUFFER, nodes.size() * sizeof(Node), nodes.data(), GL_STATIC_DRAW);
}

EMSCRIPTEN_KEEPALIVE
void render() {
    // Rendering logic using OpenGL
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

    glUseProgram(program);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);

    GLint posAttrib = glGetAttribLocation(program, "position");
    glEnableVertexAttribArray(posAttrib);
    glVertexAttribPointer(posAttrib, 3, GL_FLOAT, GL_FALSE, sizeof(Node), 0);

    glDrawArrays(GL_POINTS, 0, nodes.size());

    glDisableVertexAttribArray(posAttrib);
}

EMSCRIPTEN_KEEPALIVE
void onMouseClick(int x, int y) {
    // Convert screen coordinates to OpenGL coordinates
    float glX = (2.0f * x) / emscripten_get_canvas_element_size("canvas", nullptr, nullptr) - 1.0f;
    float glY = 1.0f - (2.0f * y) / emscripten_get_canvas_element_size("canvas", nullptr, nullptr);

    // Find the closest node to the click position
    float minDistance = std::numeric_limits<float>::max();
    Node* closestNode = nullptr;
    for (auto& node : nodes) {
        float dx = node.x - glX;
        float dy = node.y - glY;
        float distance = std::sqrt(dx * dx + dy * dy);
        if (distance < minDistance) {
            minDistance = distance;
            closestNode = &node;
        }
    }

    if (closestNode) {
        EM_ASM({
            Module.onNodeClick(Pointer_stringify($0));
        }, closestNode->id.c_str());
    }
}

}

void main_loop() {
    render();
}

int main() {
    initialize();
    emscripten_set_main_loop(main_loop, 0, 1);
    return 0;
}