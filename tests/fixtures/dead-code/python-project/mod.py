import os  # unused import


def used_func():
    return 1


def unused_func():
    return 2


class UnusedClass:
    pass


print(used_func())
