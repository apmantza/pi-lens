package corpus

import groovy.json.JsonSlurper
import java.util.concurrent.ConcurrentHashMap
import static java.lang.Math.max

/**
 * Order bookkeeping for the grammar-health corpus.
 */
class OrderService implements Serializable, Comparable<OrderService> {
    static final String DEFAULT_REGION = 'eu-west-1'
    private final Map<String, Object> cache = new ConcurrentHashMap()
    def config = [retries: 3, timeout: 30]
    def normalize = { String id -> id.trim().toLowerCase() }
    String name

    OrderService(String name) {
        this.name = name
    }

    int compareTo(OrderService other) { name <=> other.name }

    Object find(String id) {
        def order = cache[id] ?: load(id)
        return order
    }

    private Object load(String id, int attempt = 0) {
        def text = """
            SELECT * FROM orders
            WHERE id = '${id}' AND region = ${DEFAULT_REGION}
        """.stripIndent()
        try {
            def json = new JsonSlurper().parseText(text)
            cache.computeIfAbsent(id) { key -> json }
        } catch (IOException | IllegalStateException e) {
            if (attempt < config.retries) {
                return load(id, attempt + 1)
            }
            throw new RuntimeException("failed to load $id: ${e.message}", e)
        } finally {
            println "done $id"
        }
    }

    def process(List<Object> orders) {
        orders.findAll { it.total > 100 }.each { o ->
            println "Order ${o.id}: ${o.total}"
        }
        def squares = (1..10).collect { it * it }
        switch (orders.size()) {
            case 0: return 'none'
            default: return 'many'
        }
    }

    static void main(String[] args) {
        def svc = new OrderService(args ? args[0] : 'default')
        assert svc.name
        println(svc.find('42'))
        def re = ~/\d+-[a-z]+/
        if ('12-ab' ==~ re) println 'match'
    }
}

trait Auditable {
    String auditLog = ''
    void audit(String msg) { auditLog += "$msg\n" }
    abstract String owner()
}

interface Repo<T> {
    T get(String id)
    void put(String id, T value)
}

enum Status { NEW, PAID, SHIPPED }

class Stamp implements Auditable {
    String owner() { 'me' }
}

def greet = { String who -> "hello $who" }
println greet('world')
